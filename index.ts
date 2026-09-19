import { env } from "cloudflare:workers";

import {
  createMcpHandler,
  McpServer,
  requireBearerAuth,
  buildOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";

import { ClerkAuth } from "@/clerk-auth";
import { createCloudflareMemoryStore } from "@/memory-store";
import { registerMemoryTools } from "@/tools/memory.tool";

const resourceUrl = new URL(env.MCP_RESOURCE_URL);

const clerkAuth = new ClerkAuth({
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
  secretKey: env.CLERK_SECRET_KEY,
});

const gate = requireBearerAuth({
  verifier: clerkAuth,
});

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

  // authInfo is the challenge response
  if (authInfo instanceof Response) return authInfo;

  // authInfo is the resolved authInfo
  return mcpHttpHandler.fetch(c.req.raw, {
    // @ts-expect-error createMcpHonoApp provides the `parsedBody` hono var
    // but the type is not correct.
    parsedBody: c.get("parsedBody"),
    authInfo: authInfo,
  });
});

app.onError((err, c) => {
  return c.json(
    {
      error: "Unexpected error",
    },
    500,
  );
});

export default {
  fetch(req, env, ctx) {
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
