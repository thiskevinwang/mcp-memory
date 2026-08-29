import type { OAuthTokenVerifier } from "@modelcontextprotocol/server";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  ListFilter,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { timingSafeEqual } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";

import adminStyles from "./admin.generated.txt";
import { createClerkTokenVerifier } from "./clerk-token-verifier";
import { Badge } from "./components/ui/badge";
import { Button, buttonVariants } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Input } from "./components/ui/input";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";
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

export interface AdminPageOptions {
  memories: AdminMemory[];
  page: number;
  hasNextPage: boolean;
  search: string;
  filter: string;
}

export function renderAdminPage(options: AdminPageOptions) {
  return `<!doctype html>${renderToStaticMarkup(
    <AdminDocument options={options} />,
  )}`;
}

function AdminDocument({ options }: { options: AdminPageOptions }) {
  const resultLabel = options.search
    ? `Vector results for “${options.search}”`
    : options.filter
      ? `Filtered by “${options.filter}”`
      : "Full catalog";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>Memory admin</title>
        <style dangerouslySetInnerHTML={{ __html: adminStyles }} />
      </head>
      <body className="min-h-screen bg-[radial-gradient(circle_at_top_left,oklch(0.93_0.05_255),transparent_36rem)]">
        <main className="mx-auto flex max-w-[100rem] flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
          <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-primary">
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
                  <Database aria-hidden="true" className="size-4" />
                </span>
                D1 catalog · Vectorize similarity
              </div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                Memory admin
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
                Search, inspect, and update stored memories from one table.
              </p>
            </div>
            <Badge variant="secondary" className="h-7 px-3">
              {options.memories.length} shown
            </Badge>
          </header>

          <Card aria-label="Memory searches">
            <CardHeader>
              <CardTitle>Find memories</CardTitle>
              <CardDescription>
                Inputs start blank. Active query: {resultLabel}.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <SearchForm
                label="Vector search"
                name="search"
                placeholder="Search by meaning…"
                icon={<Search aria-hidden="true" />}
                buttonText="Search"
              />
              <SearchForm
                label="Text filter"
                name="filter"
                placeholder="Filter memory text…"
                icon={<ListFilter aria-hidden="true" />}
                buttonText="Filter"
              />
            </CardContent>
          </Card>

          <Card className="gap-0 overflow-hidden py-0">
            <MemoryTable memories={options.memories} />
          </Card>

          <Pagination options={options} />
        </main>
      </body>
    </html>
  );
}

function SearchForm({
  label,
  name,
  placeholder,
  icon,
  buttonText,
}: {
  label: string;
  name: "search" | "filter";
  placeholder: string;
  icon: React.ReactNode;
  buttonText: string;
}) {
  return (
    <form method="get" action="/admin" className="grid gap-2">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          id={name}
          type="search"
          name={name}
          placeholder={placeholder}
          maxLength={MAX_MEMORY_TEXT_LENGTH}
          autoComplete="off"
        />
        <Button type="submit">
          {icon}
          {buttonText}
        </Button>
      </div>
    </form>
  );
}

function MemoryTable({ memories }: { memories: AdminMemory[] }) {
  return (
    <Table className="min-w-[88rem]">
      <TableCaption className="sr-only">
        Stored memories and edit controls
      </TableCaption>
      <TableHeader className="bg-muted/60">
        <TableRow className="hover:bg-muted/60">
          <TableHead className="w-[28rem] pl-6">Memory</TableHead>
          <TableHead>Relevance</TableHead>
          <TableHead>Similarity</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="w-80">Replace text</TableHead>
          <TableHead className="w-56">Set relevance</TableHead>
          <TableHead className="pr-6 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {memories.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="h-40 text-center">
              <div className="mx-auto grid max-w-sm gap-2 text-muted-foreground">
                <Database aria-hidden="true" className="mx-auto size-6" />
                <p className="font-medium text-foreground">No memories found</p>
                <p>Change the search or return to the full catalog.</p>
              </div>
            </TableCell>
          </TableRow>
        ) : (
          memories.map((memory) => <MemoryRow key={memory.id} memory={memory} />)
        )}
      </TableBody>
    </Table>
  );
}

function MemoryRow({ memory }: { memory: AdminMemory }) {
  const pathId = encodeURIComponent(memory.id);
  const textInputId = `text-${memory.id}`;
  const relevanceInputId = `relevance-${memory.id}`;

  return (
    <TableRow>
      <TableCell className="pl-6">
        <p className="max-w-md whitespace-pre-wrap break-words leading-6">
          {memory.text}
        </p>
        <p className="mt-2 max-w-md break-all font-mono text-[0.7rem] text-muted-foreground">
          {memory.id}
        </p>
      </TableCell>
      <TableCell>
        <Badge variant={memory.relevance === null ? "outline" : "secondary"}>
          {memory.relevance === null ? "Unranked" : memory.relevance}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {memory.score === undefined ? "—" : memory.score.toFixed(4)}
      </TableCell>
      <DateCell value={memory.createdAt} />
      <DateCell value={memory.updatedAt} />
      <TableCell>
        <form
          method="post"
          action={`/admin/${pathId}/text`}
          className="grid min-w-72 gap-2"
        >
          <label htmlFor={textInputId} className="sr-only">
            Replacement text for {memory.id}
          </label>
          <Textarea
            id={textInputId}
            name="text"
            placeholder="Enter replacement text…"
            maxLength={MAX_MEMORY_TEXT_LENGTH}
            required
            className="min-h-20 resize-y"
          />
          <Button type="submit" size="sm" variant="outline">
            <Save aria-hidden="true" />
            Save text
          </Button>
        </form>
      </TableCell>
      <TableCell>
        <form
          method="post"
          action={`/admin/${pathId}/relevance`}
          className="grid min-w-48 gap-2"
        >
          <label htmlFor={relevanceInputId} className="sr-only">
            Relevance for {memory.id}
          </label>
          <Input
            id={relevanceInputId}
            type="number"
            name="relevance"
            min={0}
            max={100}
            step={1}
            placeholder="0–100"
          />
          <Button type="submit" size="sm" variant="outline">
            <Save aria-hidden="true" />
            Save relevance
          </Button>
        </form>
      </TableCell>
      <TableCell className="pr-6 text-right">
        <form method="post" action={`/admin/${pathId}/delete`}>
          <Button type="submit" size="sm" variant="destructive">
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
        </form>
      </TableCell>
    </TableRow>
  );
}

function DateCell({ value }: { value: string }) {
  return (
    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
      <time dateTime={value} title={value}>
        {formatDate(value)}
      </time>
    </TableCell>
  );
}

function Pagination({ options }: { options: AdminPageOptions }) {
  if (options.search) {
    return (
      <nav aria-label="Memory pagination">
        <a href="/admin" className={buttonVariants({ variant: "outline" })}>
          <ChevronLeft aria-hidden="true" />
          Back to catalog
        </a>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Memory pagination"
      className="flex items-center justify-between gap-4"
    >
      <a
        href={listUrl(options.page - 1, options.filter)}
        aria-disabled={options.page <= 1}
        tabIndex={options.page <= 1 ? -1 : undefined}
        className={cn(
          buttonVariants({ variant: "outline" }),
          options.page <= 1 && "pointer-events-none opacity-50",
        )}
      >
        <ChevronLeft aria-hidden="true" />
        Previous
      </a>
      <span className="text-sm font-medium text-muted-foreground">
        Page {options.page}
      </span>
      <a
        href={listUrl(options.page + 1, options.filter)}
        aria-disabled={!options.hasNextPage}
        tabIndex={!options.hasNextPage ? -1 : undefined}
        className={cn(
          buttonVariants({ variant: "outline" }),
          !options.hasNextPage && "pointer-events-none opacity-50",
        )}
      >
        Next
        <ChevronRight aria-hidden="true" />
      </a>
    </nav>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function listUrl(page: number, filter: string) {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (filter) params.set("filter", filter);
  const query = params.toString();
  return query ? `/admin?${query}` : "/admin";
}
