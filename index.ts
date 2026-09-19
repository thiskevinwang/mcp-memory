import { env } from "cloudflare:workers";

import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  requireBearerAuth,
  type AuthInfo,
  buildOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import * as z from "zod/v4";

import { ClerkAuth } from "./clerk-mcp";
import {
  createCloudflareMemoryStore,
  MAX_MEMORY_TEXT_LENGTH,
  MAX_RECALL_RESULTS,
  type MemoryStore,
} from "./memory-store";

const resourceUrl = new URL(env.MCP_RESOURCE_URL);

const clerkAuth = new ClerkAuth({
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
  secretKey: env.CLERK_SECRET_KEY,
});

const gate = requireBearerAuth({
  verifier: clerkAuth,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
});

function registerMemoryTools(server: McpServer, memoryStore: MemoryStore) {
  server.registerTool(
    "capture",
    {
      description: "Persist text as a dated memory for the authenticated user.",
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .max(MAX_MEMORY_TEXT_LENGTH)
          .describe("Original memory text to persist"),
      }),
      outputSchema: z.object({
        id: z.string(),
        createdAt: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }, ctx) => {
      const memory = await memoryStore.persistMemory(
        requireClerkUserId(ctx.http?.authInfo),
        text,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(memory) }],
        structuredContent: memory,
      };
    },
  );

  server.registerTool(
    "recall",
    {
      description:
        "Find memories for the authenticated user. Returns original text, creation date, and similarity score.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(MAX_MEMORY_TEXT_LENGTH)
          .describe("Natural-language similarity query"),
        limit: z.number().int().min(1).max(MAX_RECALL_RESULTS).default(5),
        maxAgeDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Only return memories from this many recent days"),
      }),
      outputSchema: z.object({
        memories: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            createdAt: z.string(),
            score: z.number(),
          }),
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit, maxAgeDays }, ctx) => {
      const memories = await memoryStore.recallMemories(
        requireClerkUserId(ctx.http?.authInfo),
        query,
        { limit, maxAgeDays },
      );
      const result = { memories };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}

function requireClerkUserId(authInfo: AuthInfo | undefined) {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) {
    throw new Error("Authenticated Clerk user ID is required");
  }
  return userId;
}

const memoryStore = createCloudflareMemoryStore(
  env.AI,
  env.MEMORIES,
  env.MEMORY_CATALOG,
);

const mcpHttpHandler = createMcpHandler(() => {
  const server = new McpServer({ name: "mcp-memory", version: "1.0.0" });
  registerMemoryTools(server, memoryStore);
  return server;
});

const app = createMcpHonoApp({
  allowedHosts: env.ALLOWED_HOSTS.split(","),
});

app.all(".well-known/*", async (c) => {
  return c.json(
    buildOAuthProtectedResourceMetadata({
      resourceServerUrl: resourceUrl,
      oauthMetadata: await clerkAuth.getOAuthMetadata(),
    }),
  );
});

app.all("/mcp", async (c) => {
  const authInfo = await gate(c.req.raw);
  if (authInfo instanceof Response) return authInfo;

  return mcpHttpHandler.fetch(c.req.raw, {
    parsedBody: c.get("parsedBody"),
    authInfo: authInfo,
  });
});
app.onError((err, c) => {
  console.error(err);
  return c.json(
    {
      error: err,
    },
    500,
  );
});

export default {
  fetch(req, env, ctx) {
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
