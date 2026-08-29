import type { OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { html } from "hono/html";

import { createClerkTokenVerifier } from "./clerk-token-verifier";
import {
  MAX_MEMORY_TEXT_LENGTH,
  type AdminMemory,
  type AdminMemoryStore,
} from "./memory-store";

const SESSION_COOKIE = "__Host-mcp_memory_admin";
const OAUTH_STATE_COOKIE = "__Host-mcp_memory_oauth_state";
const SESSION_SECONDS = 24 * 60 * 60;
const OAUTH_STATE_SECONDS = 10 * 60;
const MAX_FORM_BYTES = 8_192;

type HttpFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AdminAppConfig {
  clerkIssuer: string;
  clientId: string;
  clientSecret: string;
  clerkSecretKey?: string;
  sessionSecret: string;
  allowedUserId: string;
  resourceUrl: string;
  memoryStore: AdminMemoryStore;
  tokenVerifier?: OAuthTokenVerifier;
  fetch?: HttpFetch;
  now?: () => Date;
}

interface SessionPayload {
  userId: string;
  expiresAt: number;
}

export function createAdminApp(config: AdminAppConfig) {
  const app = new Hono();

  app.get("/admin/callback", async (c) => handleCallback(c, config));

  app.get("/admin", async (c) => {
    const userId = await readSession(c, config);
    if (!userId) return beginLogin(c, config);

    const search = c.req.query("search")?.trim() ?? "";
    const filter = c.req.query("filter")?.trim() ?? "";
    const page = parsePage(c.req.query("page"));
    if (search) {
      const memories = await config.memoryStore.searchMemories(userId, search);
      return c.html(
        renderAdminPage({
          memories,
          page: 1,
          hasNextPage: false,
          search,
          filter: "",
        }),
      );
    }

    const result = await config.memoryStore.listMemories(userId, {
      page,
      filter,
    });
    return c.html(
      renderAdminPage({
        memories: result.memories,
        page: result.page,
        hasNextPage: result.hasNextPage,
        search: "",
        filter,
      }),
    );
  });

  app.post("/admin/:id/text", async (c) => {
    const userId = await requirePostSession(c, config);
    if (userId instanceof Response) return userId;
    const form = await readSmallForm(c);
    if (form instanceof Response) return form;
    const text = form.get("text");
    if (typeof text !== "string") {
      return c.text("Memory text is required", 400);
    }
    const textError = validateMemoryText(text);
    if (textError) return c.text(textError, 400);
    const updated = await config.memoryStore.updateMemoryText(
      userId,
      c.req.param("id"),
      text,
    );
    return updated ? c.redirect("/admin", 303) : c.text("Not found", 404);
  });

  app.post("/admin/:id/relevance", async (c) => {
    const userId = await requirePostSession(c, config);
    if (userId instanceof Response) return userId;
    const form = await readSmallForm(c);
    if (form instanceof Response) return form;
    const rawRelevance = form.get("relevance");
    if (typeof rawRelevance !== "string") {
      return c.text("Relevance is required", 400);
    }
    const relevance = rawRelevance.trim() === "" ? null : Number(rawRelevance);
    if (
      relevance !== null &&
      (!Number.isInteger(relevance) || relevance < 0 || relevance > 100)
    ) {
      return c.text("Relevance must be an integer from 0 through 100", 400);
    }
    const updated = await config.memoryStore.updateMemoryRelevance(
      userId,
      c.req.param("id"),
      relevance,
    );
    return updated ? c.redirect("/admin", 303) : c.text("Not found", 404);
  });

  app.post("/admin/:id/delete", async (c) => {
    const userId = await requirePostSession(c, config);
    if (userId instanceof Response) return userId;
    const bodyError = validateFormRequest(c);
    if (bodyError) return bodyError;
    const deleted = await config.memoryStore.deleteMemory(
      userId,
      c.req.param("id"),
    );
    return deleted ? c.redirect("/admin", 303) : c.text("Not found", 404);
  });

  return app;
}

async function beginLogin(c: Context, config: AdminAppConfig) {
  const stateBytes = new Uint8Array(32);
  crypto.getRandomValues(stateBytes);
  const state = toBase64Url(stateBytes);
  await setSignedCookie(c, OAUTH_STATE_COOKIE, state, config.sessionSecret, {
    httpOnly: true,
    maxAge: OAUTH_STATE_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure: true,
  });

  const issuer = config.clerkIssuer.replace(/\/$/, "");
  const authorizeUrl = new URL(`${issuer}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(c));
  authorizeUrl.searchParams.set("scope", "openid profile email");
  authorizeUrl.searchParams.set("state", state);
  return c.redirect(authorizeUrl.href, 302);
}

async function handleCallback(c: Context, config: AdminAppConfig) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = await getSignedCookie(
    c,
    config.sessionSecret,
    OAUTH_STATE_COOKIE,
  );
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/", secure: true });
  if (
    !code ||
    !state ||
    typeof expectedState !== "string" ||
    !(await secureEqual(state, expectedState))
  ) {
    return c.text("Invalid OAuth callback", 400);
  }

  const accessToken = await exchangeCode(c, config, code);
  if (accessToken instanceof Response) return accessToken;
  const verifier =
    config.tokenVerifier ??
    createClerkTokenVerifier({
      issuer: config.clerkIssuer,
      opaqueTokenClientId: config.clientId,
      opaqueTokenClientSecret: config.clientSecret,
      secretKey: config.clerkSecretKey,
      resourceUrl: config.resourceUrl,
      fetch: config.fetch,
    });
  let authInfo;
  try {
    authInfo = await verifier.verifyAccessToken(accessToken);
  } catch {
    return c.text("OAuth token verification failed", 401);
  }
  const userId = authInfo.extra?.userId;
  if (typeof userId !== "string" || userId !== config.allowedUserId) {
    return c.text("Forbidden", 403);
  }

  const now = config.now?.() ?? new Date();
  const session: SessionPayload = {
    userId,
    expiresAt: Math.floor(now.getTime() / 1_000) + SESSION_SECONDS,
  };
  await setSignedCookie(
    c,
    SESSION_COOKIE,
    encodeSession(session),
    config.sessionSecret,
    {
      httpOnly: true,
      maxAge: SESSION_SECONDS,
      path: "/",
      sameSite: "Lax",
      secure: true,
    },
  );
  return c.redirect("/admin", 303);
}

async function exchangeCode(
  c: Context,
  config: AdminAppConfig,
  code: string,
): Promise<string | Response> {
  const issuer = config.clerkIssuer.replace(/\/$/, "");
  const fetch = config.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetch(`${issuer}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64Utf8(
          `${config.clientId}:${config.clientSecret}`,
        )}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(c),
      }).toString(),
    });
  } catch {
    return c.text("OAuth token exchange failed", 502);
  }
  if (!response.ok) return c.text("OAuth token exchange failed", 401);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return c.text("OAuth token response was invalid", 502);
  }
  if (!isTokenResponse(body)) {
    return c.text("OAuth token response was invalid", 502);
  }
  return body.access_token;
}

async function readSession(c: Context, config: AdminAppConfig) {
  const value = await getSignedCookie(c, config.sessionSecret, SESSION_COOKIE);
  if (typeof value !== "string") return undefined;
  const session = decodeSession(value);
  const now = config.now?.() ?? new Date();
  if (
    !session ||
    session.userId !== config.allowedUserId ||
    session.expiresAt <= Math.floor(now.getTime() / 1_000)
  ) {
    return undefined;
  }
  return session.userId;
}

async function requirePostSession(
  c: Context,
  config: AdminAppConfig,
): Promise<string | Response> {
  const origin = c.req.header("origin");
  if (!origin || origin !== new URL(c.req.url).origin) {
    return c.text("Forbidden", 403);
  }
  const userId = await readSession(c, config);
  return userId ?? c.text("Unauthorized", 401);
}

function validateFormRequest(c: Context): Response | undefined {
  const contentType = c.req.header("content-type") ?? "";
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return c.text("Unsupported form type", 415);
  }
  if (!Number.isFinite(contentLength) || contentLength > MAX_FORM_BYTES) {
    return c.text("Form is too large", 413);
  }
  return undefined;
}

async function readSmallForm(c: Context): Promise<FormData | Response> {
  const error = validateFormRequest(c);
  return error ?? c.req.raw.formData();
}

function validateMemoryText(text: string) {
  if (!text.trim()) return "Memory text must not be empty";
  if (text.length > MAX_MEMORY_TEXT_LENGTH) {
    return `Memory text must have at most ${MAX_MEMORY_TEXT_LENGTH} characters`;
  }
  return undefined;
}

function parsePage(value: string | undefined) {
  const page = Number(value ?? "1");
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function callbackUrl(c: Context) {
  return new URL("/admin/callback", c.req.url).href;
}

function encodeSession(session: SessionPayload) {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(session)));
}

function decodeSession(value: string): SessionPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(value)),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "userId" in parsed &&
      typeof parsed.userId === "string" &&
      "expiresAt" in parsed &&
      typeof parsed.expiresAt === "number"
    ) {
      return { userId: parsed.userId, expiresAt: parsed.expiresAt };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isTokenResponse(value: unknown): value is { access_token: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "access_token" in value &&
    typeof value.access_token === "string" &&
    value.access_token.length > 0
  );
}

async function secureEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return timingSafeEqual(new Uint8Array(leftHash), new Uint8Array(rightHash));
}

function base64Utf8(value: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function toBase64Url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

interface AdminPageOptions {
  memories: AdminMemory[];
  page: number;
  hasNextPage: boolean;
  search: string;
  filter: string;
}

function renderAdminPage(options: AdminPageOptions) {
  const previousUrl = listUrl(options.page - 1, options.filter);
  const nextUrl = listUrl(options.page + 1, options.filter);
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Memory admin</title>
        <style>
          :root {
            color-scheme: light dark;
            font-family: system-ui, sans-serif;
          }
          body {
            margin: 0 auto;
            max-width: 72rem;
            padding: 2rem 1rem 5rem;
          }
          h1 {
            margin-bottom: 0.25rem;
          }
          .tools,
          .memory {
            border: 1px solid #8886;
            border-radius: 0.75rem;
            padding: 1rem;
          }
          .tools {
            display: grid;
            gap: 0.75rem;
            margin: 1.5rem 0;
          }
          .tools form,
          .row {
            display: flex;
            gap: 0.5rem;
            align-items: end;
          }
          .memories {
            display: grid;
            gap: 1rem;
          }
          .memory textarea {
            box-sizing: border-box;
            min-height: 6rem;
            width: 100%;
          }
          .memory form {
            margin-top: 0.75rem;
          }
          .meta {
            color: #777;
            font-size: 0.85rem;
            overflow-wrap: anywhere;
          }
          input,
          textarea,
          button {
            font: inherit;
            padding: 0.5rem;
          }
          input[type="search"] {
            flex: 1;
          }
          button.danger {
            color: #b42318;
          }
          nav {
            display: flex;
            gap: 1rem;
            margin-top: 1.5rem;
          }
          label {
            display: grid;
            gap: 0.25rem;
          }
        </style>
      </head>
      <body>
        <h1>Memory admin</h1>
        <div class="meta">D1 catalog · Vectorize similarity</div>
        <section class="tools" aria-label="Memory searches">
          <form method="get" action="/admin">
            <label
              >Vector search
              <input
                type="search"
                name="search"
                value=${options.search}
                maxlength=${MAX_MEMORY_TEXT_LENGTH}
              />
            </label>
            <button type="submit">Search</button>
          </form>
          <form method="get" action="/admin">
            <label
              >Text filter
              <input
                type="search"
                name="filter"
                value=${options.filter}
                maxlength=${MAX_MEMORY_TEXT_LENGTH}
              />
            </label>
            <button type="submit">Filter</button>
          </form>
        </section>
        <p>${options.memories.length} memories shown</p>
        <main class="memories">${options.memories.map(renderMemory)}</main>
        ${
          options.search
            ? html`<nav><a href="/admin">Back to catalog</a></nav>`
            : html`<nav>
                ${
                  options.page > 1
                    ? html`<a href=${previousUrl}>Previous</a>`
                    : ""
                }
                <span>Page ${options.page}</span>
                ${options.hasNextPage ? html`<a href=${nextUrl}>Next</a>` : ""}
              </nav>`
        }
      </body>
    </html>`;
}

function renderMemory(memory: AdminMemory) {
  const pathId = encodeURIComponent(memory.id);
  return html`<article class="memory">
    <div class="meta">
      ${memory.id} · created ${memory.createdAt} · updated ${memory.updatedAt}
      ${memory.score === undefined ? "" : ` · cosine ${memory.score.toFixed(4)}`}
    </div>
    <form method="post" action=${`/admin/${pathId}/text`}>
      <label
        >Text
        <textarea name="text" maxlength=${MAX_MEMORY_TEXT_LENGTH} required>
${memory.text}</textarea>
      </label>
      <button type="submit">Save text</button>
    </form>
    <form class="row" method="post" action=${`/admin/${pathId}/relevance`}>
      <label
        >Relevance (optional, 0–100)
        <input
          type="number"
          name="relevance"
          min="0"
          max="100"
          step="1"
          value=${memory.relevance ?? ""}
        />
      </label>
      <button type="submit">Save relevance</button>
    </form>
    <form method="post" action=${`/admin/${pathId}/delete`}>
      <button class="danger" type="submit">Delete</button>
    </form>
  </article>`;
}

function listUrl(page: number, filter: string) {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (filter) params.set("filter", filter);
  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}
