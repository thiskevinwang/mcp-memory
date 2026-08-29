import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import * as z from "zod/v4";
import {
  configure,
  defaultConsoleFormatter,
  getConsoleSink,
  type LogRecord,
} from "@logtape/logtape";
import { honoLogger } from "@logtape/hono";

import { createClerkTokenVerifier } from "./clerk-token-verifier";
import {
  createCloudflareMemoryStore,
  MAX_MEMORY_TEXT_LENGTH,
  MAX_RECALL_RESULTS,
  type MemoryStore,
} from "./memory-store";

const clerkAuthLoggerCategory = ["hono", "auth", "clerk"];

function formatConsoleLog(record: LogRecord) {
  const formatted = defaultConsoleFormatter(record);
  const isClerkAuthLog =
    record.category.join(".") === clerkAuthLoggerCategory.join(".");

  return isClerkAuthLog ? [...formatted, record.properties] : formatted;
}

await configure({
  sinks: { console: getConsoleSink({ formatter: formatConsoleLog }) },
  loggers: [
    {
      category: ["logtape", "meta"],
      sinks: ["console"],
      lowestLevel: "warning",
    },
    { category: ["hono"], sinks: ["console"], lowestLevel: "info" },
  ],
});

const supportedScopes = ["users:read", "users:write"];

export interface McpAppConfig {
  clerkIssuer: string;
  allowedEmail: string;
  opaqueTokenClientId?: string;
  opaqueTokenClientSecret?: string;
  secretKey?: string;
  resourceUrl: string;
  allowedHosts?: string[];
  tokenVerifier?: OAuthTokenVerifier;
  memoryStore?: MemoryStore;
}

export function createProtectedMcpApp(config: McpAppConfig) {
  const resourceUrl = new URL(config.resourceUrl);
  const gate = requireBearerAuth({
    verifier:
      config.tokenVerifier ??
      createClerkTokenVerifier({
        issuer: config.clerkIssuer,
        opaqueTokenClientId: config.opaqueTokenClientId,
        opaqueTokenClientSecret: config.opaqueTokenClientSecret,
        secretKey: config.secretKey,
        resourceUrl: config.resourceUrl,
      }),
    requiredScopes: [
      "users:read",
      "openid",
      "profile",
      "email",
      "offline_access",
    ],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "mcp-memory", version: "1.0.0" });
    if (config.memoryStore) {
      registerMemoryTools(server, config.memoryStore);
    }
    return server;
  });

  const app = createMcpHonoApp({
    allowedHosts: config.allowedHosts ?? [resourceUrl.hostname],
    allowedOrigins: [resourceUrl.hostname],
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json({
      resource: config.resourceUrl,
      authorization_servers: [config.clerkIssuer],
      bearer_methods_supported: ["header"],
      scopes_supported: supportedScopes,
    }),
  );
  app.all("/mcp", async (c: Context) => {
    const authInfo = await gate(c.req.raw);
    if (authInfo instanceof Response) {
      return authInfo;
    }

    if (authInfo.extra?.email !== config.allowedEmail) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    return handler.fetch(c.req.raw, {
      authInfo,
      parsedBody: c.get("parsedBody"),
    });
  });

  return app;
}

function registerMemoryTools(server: McpServer, memoryStore: MemoryStore) {
  server.registerTool(
    "remember",
    {
      description:
        "Persist text as a dated memory for the authenticated user. The server creates and stores its vector embedding.",
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
        "Find memories for the authenticated user by vector similarity. Returns original text, creation date, and similarity score.",
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

function createWorkerApp(env: Env) {
  const app = createProtectedMcpApp({
    clerkIssuer: env.CLERK_ISSUER,
    opaqueTokenClientId: env.CLERK_OAUTH_CLIENT_ID,
    opaqueTokenClientSecret: env.CLERK_OAUTH_CLIENT_SECRET,
    secretKey: env.CLERK_SECRET_KEY,
    allowedEmail: env.ALLOWED_EMAIL,
    resourceUrl: env.MCP_RESOURCE_URL,
    allowedHosts: env.ALLOWED_HOSTS.split(",").map((host) => host.trim()),
    memoryStore: createCloudflareMemoryStore(env.AI, env.MEMORIES),
  });
  app.use(honoLogger());
  return app;
}

export default {
  fetch(request, env) {
    return createWorkerApp(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
