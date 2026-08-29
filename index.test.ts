import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createClerkTokenVerifier } from "./clerk-token-verifier";
import { createProtectedMcpApp } from "./index";
import type { MemoryStore } from "./memory-store";

const app = createProtectedMcpApp({
  clerkIssuer: "https://clerk.clerk.com",
  allowedUserId: "user_123",
  resourceUrl: "http://localhost:3000/mcp",
});

const appWithTokenWithoutScopes = createProtectedMcpApp({
  clerkIssuer: "https://clerk.clerk.com",
  allowedUserId: "user_123",
  resourceUrl: "http://localhost:3000/mcp",
  tokenVerifier: {
    async verifyAccessToken(token) {
      return {
        token,
        clientId: "dynamic-client",
        scopes: [],
        expiresAt: 4_102_444_800,
      };
    },
  },
});

const persistedMemoryCalls: Array<{ userId: string; text: string }> = [];
const recalledMemoryCalls: Array<{
  userId: string;
  query: string;
  limit: number;
  maxAgeDays?: number;
}> = [];
const memoryStore: MemoryStore = {
  async persistMemory(userId, text) {
    persistedMemoryCalls.push({ userId, text });
    return {
      id: "memory-123",
      createdAt: "2026-08-28T12:34:56.000Z",
    };
  },
  async recallMemories(userId, query, options) {
    recalledMemoryCalls.push({ userId, query, ...options });
    return [
      {
        id: "memory-123",
        text: "The launch date is October 4.",
        createdAt: "2026-08-28T12:34:56.000Z",
        score: 0.92,
      },
    ];
  },
};
const appWithMemoryTools = createProtectedMcpApp({
  clerkIssuer: "https://clerk.clerk.com",
  allowedUserId: "user_123",
  resourceUrl: "http://localhost:3000/mcp",
  memoryStore,
  tokenVerifier: {
    async verifyAccessToken(token) {
      return {
        token,
        clientId: "dynamic-client",
        scopes: [
          "users:read",
          "openid",
          "profile",
          "email",
          "offline_access",
        ],
        expiresAt: 4_102_444_800,
        extra: { userId: "user_123", email: "kwangsan@gmail.com" },
      };
    },
  },
});
const appWithUnauthorizedUser = createProtectedMcpApp({
  clerkIssuer: "https://clerk.clerk.com",
  allowedUserId: "user_123",
  resourceUrl: "http://localhost:3000/mcp",
  memoryStore,
  tokenVerifier: {
    async verifyAccessToken(token) {
      return {
        token,
        clientId: "dynamic-client",
        scopes: [
          "users:read",
          "openid",
          "profile",
          "email",
          "offline_access",
        ],
        expiresAt: 4_102_444_800,
        extra: { userId: "user_456", email: "other@example.com" },
      };
    },
  },
});

describe("OAuth protected resource metadata", () => {
  test("declares the MCP resource, Clerk issuer, and supported scopes", async () => {
    const response = await app.request(
      "http://localhost:3000/.well-known/oauth-protected-resource/mcp",
      { headers: { Host: "localhost:3000" } },
    );

    expect(response.status).toBe(200);
    expect<unknown>(await response.json()).toEqual({
      resource: "http://localhost:3000/mcp",
      authorization_servers: ["https://clerk.clerk.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["users:read", "users:write"],
    });
  });
});

describe("MCP bearer authentication", () => {
  test("rejects an MCP request without a bearer token", async () => {
    const response = await app.request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        Host: "localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata=\"http://localhost:3000/.well-known/oauth-protected-resource/mcp\"",
    );
  });

  test("rejects a token that lacks users:read", async () => {
    const response = await appWithTokenWithoutScopes.request(
      "http://localhost:3000/mcp",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid-but-unscoped",
          Host: "localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    );
  });

  test("runs the remember tool after Clerk JWT verification", async () => {
    persistedMemoryCalls.length = 0;
    const issuer = "https://clerk.clerk.com";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({
      client_id: "dynamic-client",
      scope: "users:read openid profile email offline_access",
      email: "kwangsan@gmail.com",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setSubject("user_123")
      .setExpirationTime("1h")
      .sign(privateKey);
    const jwtProtectedApp = createProtectedMcpApp({
      clerkIssuer: issuer,
      allowedUserId: "user_123",
      resourceUrl: "http://localhost:3000/mcp",
      memoryStore,
      tokenVerifier: createClerkTokenVerifier({
        issuer,
        resourceUrl: "http://localhost:3000/mcp",
        fetch: async () =>
          Response.json({ keys: [{ ...jwk, kid: "test-key" }] }),
      }),
    });
    const response = await jwtProtectedApp.request(
      "http://localhost:3000/mcp",
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          Host: "localhost:3000",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "remember",
            arguments: { text: "The launch date is October 4." },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(persistedMemoryCalls).toEqual([
      { userId: "user_123", text: "The launch date is October 4." },
    ]);
    const dataLine = (await response.text())
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();
    expect<unknown>(JSON.parse(dataLine!.slice("data: ".length))).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        structuredContent: {
          id: "memory-123",
          createdAt: "2026-08-28T12:34:56.000Z",
        },
      },
    });
  });

  test("passes the authenticated user to vector memory retrieval", async () => {
    recalledMemoryCalls.length = 0;
    const response = await appWithMemoryTools.request(
      "http://localhost:3000/mcp",
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer valid-token",
          Host: "localhost:3000",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "recall",
            arguments: {
              query: "When is launch?",
              limit: 3,
              maxAgeDays: 30,
            },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(recalledMemoryCalls).toEqual([
      {
        userId: "user_123",
        query: "When is launch?",
        limit: 3,
        maxAgeDays: 30,
      },
    ]);
    expect(await response.text()).toContain("The launch date is October 4.");
  });

  test("rejects an authenticated user with a different Clerk user ID", async () => {
    persistedMemoryCalls.length = 0;
    const response = await appWithUnauthorizedUser.request(
      "http://localhost:3000/mcp",
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer valid-token",
          Host: "localhost:3000",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "remember",
            arguments: { text: "This must not be stored." },
          },
        }),
      },
    );

    expect(response.status).toBe(403);
    expect<unknown>(await response.json()).toEqual({ error: "Forbidden" });
    expect(persistedMemoryCalls).toEqual([]);
  });
});

describe("Clerk token verifier", () => {
  test("validates a Clerk JWT with its JWKS", async () => {
    const issuer = "https://clerk.clerk.com";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({
      client_id: "dynamic-client",
      scope: "users:read users:create",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setSubject("user_123")
      .setAudience("http://localhost:3000/mcp")
      .setExpirationTime("1h")
      .sign(privateKey);
    const verifier = createClerkTokenVerifier({
      issuer,
      resourceUrl: "http://localhost:3000/mcp",
      secretKey: "sk_test_example",
      fetch: async () => Response.json({ keys: [{ ...jwk, kid: "test-key" }] }),
    });

    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
      token,
      clientId: "dynamic-client",
      scopes: ["users:read", "users:create"],
      extra: { userId: "user_123" },
    });
  });

  test("introspects an opaque Clerk token", async () => {
    const verifier = createClerkTokenVerifier({
      issuer: "https://clerk.clerk.com",
      resourceUrl: "http://localhost:3000/mcp",
      opaqueTokenClientId: "resource-server",
      opaqueTokenClientSecret: "resource-server-secret",
      fetch: async (input, init) => {
        expect(input).toBe("https://clerk.clerk.com/oauth/token_info");
        expect(init?.headers).toMatchObject({
          Authorization: "Basic cmVzb3VyY2Utc2VydmVyOnJlc291cmNlLXNlcnZlci1zZWNyZXQ=",
        });
        expect(init?.body).toBe("token=opaque-token");
        return Response.json({
          active: true,
          client_id: "dynamic-client",
          iat: 1_787_890_333,
          scope: "users:read users:create",
          email: "kwangsan@gmail.com",
          sub: "user_123",
        });
      },
    });

    const authInfo = await verifier.verifyAccessToken("opaque-token");
    expect(authInfo).toMatchObject({
      token: "opaque-token",
      clientId: "dynamic-client",
      scopes: ["users:read", "users:create"],
      resource: new URL("http://localhost:3000/mcp"),
      extra: { userId: "user_123" },
    });
    expect(authInfo.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  test("does not use the MCP resource URL as a JWT audience", async () => {
    const issuer = "https://clerk.clerk.com";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({
      client_id: "dynamic-client",
      scope: "users:read",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setSubject("user_123")
      .setAudience("http://localhost:4000/mcp")
      .setExpirationTime("1h")
      .sign(privateKey);
    const verifier = createClerkTokenVerifier({
      issuer,
      resourceUrl: "http://localhost:3000/mcp",
      fetch: async () => Response.json({ keys: [{ ...jwk, kid: "test-key" }] }),
    });

    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
      token,
      clientId: "dynamic-client",
    });
  });

  test("verifies an opaque token with the Clerk Backend API", async () => {
    const verifier = createClerkTokenVerifier({
      issuer: "https://clerk.clerk.com",
      resourceUrl: "http://localhost:3000/mcp",
      secretKey: "sk_test_example",
      fetch: async (input, init) => {
        expect(input).toBe(
          "https://api.clerk.com/oauth_applications/access_tokens/verify",
        );
        expect(init).toMatchObject({
          method: "POST",
          headers: {
            Authorization: "Bearer sk_test_example",
            "Content-Type": "application/json",
          },
        });
        expect(init?.body).toBe(
          JSON.stringify({ access_token: "opaque-token" }),
        );
        return Response.json({
          object: "oauth_access_token",
          id: "oat_123",
          client_id: "dynamic-client",
          subject: "user_123",
          scopes: ["users:read", "users:create"],
          revoked: false,
          expired: false,
          expiration: 4_102_444_800,
          created_at: 1_787_890_333,
          updated_at: 1_787_890_333,
        });
      },
    });

    await expect(verifier.verifyAccessToken("opaque-token")).resolves.toEqual({
      token: "opaque-token",
      clientId: "dynamic-client",
      scopes: ["users:read", "users:create"],
      expiresAt: 4_102_444_800,
      resource: new URL("http://localhost:3000/mcp"),
      extra: { userId: "user_123" },
    });
  });

  test("rejects an inactive Clerk Backend API token", async () => {
    const verifier = createClerkTokenVerifier({
      issuer: "https://clerk.clerk.com",
      resourceUrl: "http://localhost:3000/mcp",
      secretKey: "sk_test_example",
      fetch: async () => Response.json({ active: false }),
    });

    await expect(verifier.verifyAccessToken("opaque-token")).rejects.toThrow(
      "Inactive Clerk opaque access token",
    );
  });

  test("rejects a JWT without a Clerk user subject", async () => {
    const issuer = "https://clerk.clerk.com";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({
      client_id: "dynamic-client",
      scope: "users:read",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("http://localhost:3000/mcp")
      .setExpirationTime("1h")
      .sign(privateKey);
    const verifier = createClerkTokenVerifier({
      issuer,
      resourceUrl: "http://localhost:3000/mcp",
      fetch: async () => Response.json({ keys: [{ ...jwk, kid: "test-key" }] }),
    });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(
      "Invalid Clerk JWT access token",
    );
  });
});
