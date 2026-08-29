import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type {
  AuthInfo,
  OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import * as z from "zod/v4";
import {
  configure,
  defaultConsoleFormatter,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  type LogRecord,
} from "@logtape/logtape";
import { honoLogger } from "@logtape/hono";

import { createAdminApp } from "./admin";
import { createClerkTokenVerifier } from "./clerk-token-verifier";
import {
  createCloudflareMemoryStore,
  MAX_MEMORY_TEXT_LENGTH,
  MAX_RECALL_RESULTS,
  type MemoryStore,
} from "./memory-store";

const clerkAuthLoggerCategory = ["hono", "auth", "clerk"];
const mcpAuthLogger = getLogger(["hono", "auth", "mcp"]);

function isCloudflareWorkerRuntime() {
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
  );
}

function formatConsoleLog(record: LogRecord) {
  const formatted = defaultConsoleFormatter(record);
  const isClerkAuthLog =
    record.category.join(".") === clerkAuthLoggerCategory.join(".");

  return isClerkAuthLog ? [...formatted, record.properties] : formatted;
}

await configure({
  sinks: {
    console: getConsoleSink({
      formatter: isCloudflareWorkerRuntime()
        ? getJsonLinesFormatter({ properties: "flatten" })
        : formatConsoleLog,
    }),
  },
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
  allowedUserId: string;
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
    const parsedBody = c.get("parsedBody");
    const requestContext = {
      path: c.req.path,
      method: c.req.method,
      host: c.req.header("host") ?? null,
      origin: c.req.header("origin") ?? null,
      mcpProtocolVersion: c.req.header("mcp-protocol-version") ?? null,
      jsonrpcMethod:
        parsedBody &&
        typeof parsedBody === "object" &&
        "method" in parsedBody &&
        typeof parsedBody.method === "string"
          ? parsedBody.method
          : null,
    };

    const authInfo = await gate(c.req.raw);
    if (authInfo instanceof Response) {
      mcpAuthLogger.warn("mcp_auth_rejected", {
        ...requestContext,
        status: authInfo.status,
        wwwAuthenticate: authInfo.headers.get("WWW-Authenticate"),
      });
      return authInfo;
    }

    const tokenUserId =
      typeof authInfo.extra?.userId === "string" ? authInfo.extra.userId : null;
    if (tokenUserId !== config.allowedUserId) {
      mcpAuthLogger.warn("mcp_user_forbidden", {
        ...requestContext,
        allowedUserId: config.allowedUserId,
        tokenUserId,
        clientId: authInfo.clientId,
        scopes: authInfo.scopes,
      });
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    mcpAuthLogger.info("mcp_request_authorized", {
      ...requestContext,
      userId: tokenUserId,
      clientId: authInfo.clientId,
    });

    return handler.fetch(c.req.raw, {
      authInfo,
      parsedBody,
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
  const memoryStore = createCloudflareMemoryStore(
    env.AI,
    env.MEMORIES,
    env.MEMORY_CATALOG,
  );
  const mcpApp = createProtectedMcpApp({
    clerkIssuer: env.CLERK_ISSUER,
    opaqueTokenClientId: env.CLERK_OAUTH_CLIENT_ID,
    opaqueTokenClientSecret: env.CLERK_OAUTH_CLIENT_SECRET,
    secretKey: env.CLERK_SECRET_KEY,
    allowedUserId: env.ALLOWED_USER_ID,
    resourceUrl: env.MCP_RESOURCE_URL,
    allowedHosts: env.ALLOWED_HOSTS.split(",").map((host) => host.trim()),
    memoryStore,
  });
  const adminApp = createAdminApp({
    clerkIssuer: env.CLERK_ISSUER,
    clientId: env.CLERK_OAUTH_CLIENT_ID,
    clientSecret: env.CLERK_OAUTH_CLIENT_SECRET,
    clerkSecretKey: env.CLERK_SECRET_KEY,
    sessionSecret: env.ADMIN_SESSION_SECRET,
    allowedUserId: env.ALLOWED_USER_ID,
    resourceUrl: env.MCP_RESOURCE_URL,
    memoryStore,
  });
  const app = new Hono();
  app.use(honoLogger());
  app.onError((error, c) => {
    console.error(
      JSON.stringify({
        message: "unhandled_request_error",
        method: c.req.method,
        path: c.req.path,
        error: error.message,
      }),
    );
    return c.json({ error: "Internal server error" }, 500);
  });
  app.route("/", mcpApp);
  app.route("/", adminApp);
  return app;
}

export default {
  fetch(request, env) {
    return createWorkerApp(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
