import { describe, expect, test } from "bun:test";

import { createAdminApp } from "./admin";
import type { AdminMemoryStore } from "./memory-store";

const calls: string[] = [];
const memoryStore: AdminMemoryStore = {
  async persistMemory() {
    return { id: "memory-1", createdAt: "2026-08-29T12:00:00.000Z" };
  },
  async recallMemories() {
    return [];
  },
  async listMemories(userId, options) {
    calls.push(`list:${userId}:${options.page}`);
    return {
      memories: [
        {
          id: "memory-1",
          userId,
          text: "Use <strong>escaped</strong> text",
          createdAt: "2026-08-29T12:00:00.000Z",
          updatedAt: "2026-08-29T12:00:00.000Z",
          relevance: 64,
        },
      ],
      page: 1,
      hasNextPage: false,
    };
  },
  async searchMemories() {
    return [];
  },
  async updateMemoryText() {
    return true;
  },
  async updateMemoryRelevance() {
    return true;
  },
  async deleteMemory() {
    return true;
  },
};

const app = createAdminApp({
  clerkIssuer: "https://clerk.example.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  sessionSecret: "test-session-secret-with-more-than-32-characters",
  allowedUserId: "user_123",
  resourceUrl: "https://memory.example.com/mcp",
  memoryStore,
  now: () => new Date("2026-08-29T12:00:00.000Z"),
  tokenVerifier: {
    async verifyAccessToken(token) {
      expect(token).toBe("access-token");
      return {
        token,
        clientId: "client-id",
        scopes: ["openid"],
        expiresAt: 4_102_444_800,
        extra: { userId: "user_123" },
      };
    },
  },
  fetch: async (input, init) => {
    expect(input).toBe("https://clerk.example.com/oauth/token");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    return Response.json({ access_token: "access-token" });
  },
});

describe("admin OAuth and session", () => {
  test("creates a signed session and renders escaped memory text", async () => {
    calls.length = 0;
    const login = await app.request("https://memory.example.com/admin");
    expect(login.status).toBe(302);
    const location = new URL(login.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://clerk.example.com/oauth/authorize",
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://memory.example.com/admin/callback",
    );
    const state = location.searchParams.get("state")!;
    const stateCookie = cookiePair(
      login.headers.get("set-cookie"),
      "__Host-mcp_memory_oauth_state",
    );

    const callback = await app.request(
      `https://memory.example.com/admin/callback?code=auth-code&state=${state}`,
      { headers: { Cookie: stateCookie } },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/admin");
    const sessionCookie = cookiePair(
      callback.headers.get("set-cookie"),
      "__Host-mcp_memory_admin",
    );

    const admin = await app.request("https://memory.example.com/admin", {
      headers: { Cookie: sessionCookie },
    });
    expect(admin.status).toBe(200);
    const body = await admin.text();
    expect(body).toContain("Use &lt;strong&gt;escaped&lt;/strong&gt; text");
    expect(body).not.toContain("Use <strong>escaped</strong> text");
    expect(body).toContain('data-slot="table"');
    expect(body).toContain('data-slot="button"');

    const textInput = body.match(
      /<textarea[^>]*name="text"[^>]*>.*?<\/textarea>/s,
    )?.[0];
    expect(textInput).toBeDefined();
    expect(textInput).not.toContain("Use &lt;strong&gt;");

    for (const name of ["search", "filter", "relevance"]) {
      const input = body.match(
        new RegExp(`<input[^>]*name="${name}"[^>]*>`),
      )?.[0];
      expect(input).toBeDefined();
      expect(input).not.toContain("value=");
    }
    expect(calls).toEqual(["list:user_123:1"]);

    const crossOriginPost = await app.request(
      "https://memory.example.com/admin/memory-1/delete",
      {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          Origin: "https://attacker.example.com",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      },
    );
    expect(crossOriginPost.status).toBe(403);
  });
});

function cookiePair(header: string | null, name: string) {
  if (!header) throw new Error("Expected Set-Cookie header");
  const match = header.match(new RegExp(`(?:^|, )(${name}=[^;]+)`));
  if (!match) throw new Error(`Expected ${name} cookie`);
  return match[1];
}
