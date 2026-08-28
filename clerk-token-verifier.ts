import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
} from "jose";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

export interface ClerkTokenVerifierOptions {
  issuer: string;
  opaqueTokenClientId?: string;
  opaqueTokenClientSecret?: string;
  resourceUrl: string;
  fetch?: HttpFetch;
}

type HttpFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ClerkIntrospectionResponse {
  active?: unknown;
  client_id?: unknown;
  exp?: unknown;
  scope?: unknown;
  sub?: unknown;
  resource?: unknown;
}

export function createClerkTokenVerifier(
  options: ClerkTokenVerifierOptions,
): OAuthTokenVerifier {
  const issuer = options.issuer.replace(/\/$/, "");
  const resourceUrl = new URL(options.resourceUrl);
  const fetch = options.fetch ?? globalThis.fetch;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    [customFetch]: fetch,
  });

  return {
    async verifyAccessToken(token) {
      if (token.split(".").length === 3) {
        return verifyJwtAccessToken(token, issuer, resourceUrl, jwks);
      }

      return verifyOpaqueAccessToken(token, issuer, resourceUrl, fetch, options);
    },
  };
}

async function verifyJwtAccessToken(
  token: string,
  issuer: string,
  resourceUrl: URL,
  jwks: ReturnType<typeof createRemoteJWKSet>,
): Promise<AuthInfo> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      audience: resourceUrl.href,
      issuer,
    });

    return toAuthInfo(token, payload, resourceUrl);
  } catch {
    throw invalidToken("Invalid Clerk JWT access token");
  }
}

async function verifyOpaqueAccessToken(
  token: string,
  issuer: string,
  resourceUrl: URL,
  fetch: HttpFetch,
  options: ClerkTokenVerifierOptions,
): Promise<AuthInfo> {
  if (!options.opaqueTokenClientId || !options.opaqueTokenClientSecret) {
    throw invalidToken("Opaque token verification is not configured");
  }

  let response: Response;
  try {
    response = await fetch(`${issuer}/oauth/token_info`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64Utf8(
          `${options.opaqueTokenClientId}:${options.opaqueTokenClientSecret}`,
        )}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    throw invalidToken("Clerk opaque token introspection failed");
  }

  if (!response.ok) {
    throw invalidToken("Invalid Clerk opaque access token");
  }

  let result: ClerkIntrospectionResponse;
  try {
    result = (await response.json()) as ClerkIntrospectionResponse;
  } catch {
    throw invalidToken("Invalid Clerk opaque-token response");
  }

  if (result.active !== true) {
    throw invalidToken("Inactive Clerk opaque access token");
  }

  if (result.resource !== resourceUrl.href) {
    throw invalidToken("Clerk opaque access token has an invalid resource");
  }

  return toAuthInfo(token, result, resourceUrl);
}

function toAuthInfo(
  token: string,
  claims: JWTPayload | ClerkIntrospectionResponse,
  resource: URL,
): AuthInfo {
  const clientId = readClientId(claims);
  const expiresAt = claims.exp;

  if (!clientId || typeof expiresAt !== "number") {
    throw invalidToken("Clerk access token has required claims missing");
  }

  const userId = typeof claims.sub === "string" ? claims.sub : undefined;
  if (!userId) {
    throw invalidToken("Clerk access token has no user subject");
  }

  return {
    token,
    clientId,
    scopes: readScopes(claims.scope),
    expiresAt,
    resource,
    extra: { userId },
  };
}

function readClientId(claims: JWTPayload | ClerkIntrospectionResponse): string | undefined {
  if (typeof claims.client_id === "string") {
    return claims.client_id;
  }

  if ("azp" in claims && typeof claims.azp === "string") {
    return claims.azp;
  }
}

function readScopes(scope: unknown): string[] {
  return typeof scope === "string" ? scope.split(" ").filter(Boolean) : [];
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function invalidToken(message: string) {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}
