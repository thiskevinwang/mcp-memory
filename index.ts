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
import {
  configure,
  defaultConsoleFormatter,
  getConsoleSink,
  type LogRecord,
} from "@logtape/logtape";
import { honoLogger } from "@logtape/hono";

import { createClerkTokenVerifier } from "./clerk-token-verifier";

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
  opaqueTokenClientId?: string;
  opaqueTokenClientSecret?: string;
  secretKey?: string;
  resourceUrl: string;
  tokenVerifier?: OAuthTokenVerifier;
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
    const authInfo = await gate(c.req.raw);
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

function createWorkerApp(env: Env) {
  const app = createProtectedMcpApp({
    clerkIssuer: env.CLERK_ISSUER,
    opaqueTokenClientId: env.CLERK_OAUTH_CLIENT_ID,
    opaqueTokenClientSecret: env.CLERK_OAUTH_CLIENT_SECRET,
    secretKey: env.CLERK_SECRET_KEY,
    resourceUrl: env.MCP_RESOURCE_URL,
  });
  app.use(honoLogger());
  return app;
}

export default {
  fetch(request, env) {
    return createWorkerApp(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
