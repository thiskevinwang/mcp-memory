import { env } from "cloudflare:workers";

import {
  createMcpHandler,
  McpServer,
  requireBearerAuth,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  resourceUrlFromServerUrl,
  type ClientRequest,
  isJSONRPCRequest,
} from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";

import { ClerkAuth } from "@/clerk-auth";

import { createCloudflareMemoryStore } from "@/tools/memory.store";
import { registerAuthTools } from "@/tools/auth.tool";
import { registerMemoryTools } from "@/tools/memory.tool";
import { isPublicRequest, acl } from "@/acl";

const resourceUrl = resourceUrlFromServerUrl(env.MCP_RESOURCE_URL);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

const clerkAuth = new ClerkAuth({
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
  secretKey: env.CLERK_SECRET_KEY,
});

const gate = requireBearerAuth({
  verifier: clerkAuth,
  resourceMetadataUrl,
});

const mcpHttpHandler = createMcpHandler(() => {
  const server = new McpServer({ name: "mcp-memory", version: "1.0.0" });
  // whoami
  registerAuthTools(server);

  // capture, recall
  const memoryStore = createCloudflareMemoryStore(env.AI, env.MEMORIES);
  registerMemoryTools(server, memoryStore);

  return server;
});

const app = createMcpHonoApp({
  allowedHosts: env.ALLOWED_HOSTS,
});

app.get("/", (c) => {
  return c.text("You're probably looking for /mcp");
});

// returns
// - resource: <this server>
// - authorization_servers: [<discovered from oauth metadata>]
app.get(".well-known/oauth-protected-resource/mcp", async (c) => {
  return c.json(
    buildOAuthProtectedResourceMetadata({
      resourceServerUrl: resourceUrl,
      oauthMetadata: await clerkAuth.getOAuthMetadata(),
    }),
  );
});

app.all(
  "/mcp",
  // handler
  async (c) => {
    // @ts-expect-error - createMcpHonoApp provides the `parsedBody` Hono variable.
    const parsedBody = c.get("parsedBody") as ClientRequest;
    if (!isJSONRPCRequest(parsedBody)) {
      // invalid client requests shouldn't even be considered for auth
      return c.json(
        {
          error: "invalid_client_request",
          error_description: "Invalid client request",
        },
        422,
      );
    }

    const authInfo = await gate(c.req.raw);

    if (authInfo instanceof Response) {
      // this means no auth is present, and authInfo is a challenge
      // but we can still let some "public" requests go through
      if (isPublicRequest(parsedBody, acl)) {
        return mcpHttpHandler.fetch(c.req.raw, {
          parsedBody,
        });
      }
      return authInfo;
    }

    return mcpHttpHandler.fetch(c.req.raw, {
      parsedBody,
      authInfo: authInfo,
    });
  },
);

app.onError((err, c) => {
  console.error(err);
  return c.json(
    {
      error: "unexpected_error",
      error_description: "Unexpected error",
    },
    500,
  );
});

export default {
  fetch(req, env, ctx) {
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
