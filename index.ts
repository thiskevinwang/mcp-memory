import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import * as z from "zod/v4";

import { createClerkTokenVerifier } from "./clerk-token-verifier";

const supportedScopes = ["users:read", "users:create"];

export interface McpAppConfig {
  clerkIssuer: string;
  opaqueTokenClientId?: string;
  opaqueTokenClientSecret?: string;
  resourceUrl: string;
  tokenVerifier?: OAuthTokenVerifier;
}

export function createProtectedMcpApp(config: McpAppConfig) {
  const resourceUrl = new URL(config.resourceUrl);
  const authenticate = requireBearerAuth({
    verifier:
      config.tokenVerifier ??
      createClerkTokenVerifier({
        issuer: config.clerkIssuer,
        opaqueTokenClientId: config.opaqueTokenClientId,
        opaqueTokenClientSecret: config.opaqueTokenClientSecret,
        resourceUrl: config.resourceUrl,
      }),
    requiredScopes: ["users:read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "notes", version: "1.0.0" });
    server.registerTool(
      "add-note",
      {
        description: "Append a note",
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => ({
        content: [{ type: "text", text: `Saved: ${text}` }],
      }),
    );
    return server;
  });

  const app = createMcpHonoApp({
    allowedHosts: [resourceUrl.hostname],
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
    const authInfo = await authenticate(c.req.raw);
    if (authInfo instanceof Response) {
      return authInfo;
    }

    return handler.fetch(c.req.raw, {
      authInfo,
      parsedBody: c.get("parsedBody"),
    });
  });

  return app;
}

const app = createProtectedMcpApp({
  clerkIssuer: process.env.CLERK_ISSUER ?? "https://clerk.clerk.com",
  opaqueTokenClientId: process.env.CLERK_OAUTH_CLIENT_ID,
  opaqueTokenClientSecret: process.env.CLERK_OAUTH_CLIENT_SECRET,
  resourceUrl: process.env.MCP_RESOURCE_URL ?? "http://localhost:3000/mcp",
});

if (import.meta.main) {
  const port = Number(process.env.MCP_PORT ?? 3000);
  Bun.serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port,
  });
  console.log(`MCP server listening at http://localhost:${port}/mcp`);
}

export default app;
