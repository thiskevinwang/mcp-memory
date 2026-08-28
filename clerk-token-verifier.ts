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
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["hono", "auth", "clerk"]);

type HttpFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
export interface ClerkTokenVerifierOptions {
  issuer: string;
  opaqueTokenClientId?: string;
  opaqueTokenClientSecret?: string;
  secretKey?: string;
  resourceUrl: string;
  fetch?: HttpFetch;
}

interface ClerkIntrospectionResponse {
  active: boolean;
  client_id: string;
  iat: number;
  scope: string;
  sub: string;
}

interface ClerkBackendAccessTokenResponse {
  client_id: string;
  subject: string;
  scopes: string[];
  revoked: boolean;
  expired: boolean;
  expiration: number;
}

export class ClerkTokenVerifier implements OAuthTokenVerifier {
  constructor(private options: ClerkTokenVerifierOptions) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const issuer = this.options.issuer.replace(/\/$/, "");
    const resourceUrl = new URL(this.options.resourceUrl);
    const fetch = this.options.fetch ?? globalThis.fetch;
    const jwks = createRemoteJWKSet(
      new URL(`${issuer}/.well-known/jwks.json`),
      {
        [customFetch]: fetch,
      },
    );

    /**
     * JWT verification
     */
    if (token.split(".").length === 3) {
      logger.info("clerk_jwt_verification_start", {
        issuer,
      });
      return verifyJwtAccessToken(token, issuer, resourceUrl, jwks);
    }

    /**
     * Backend access token verification
     */
    if (this.options.secretKey) {
      return verifyBackendAccessToken(
        token,
        issuer,
        resourceUrl,
        fetch,
        this.options.secretKey,
      );
    }

    /**
     * Opaque token verification
     */
    logger.info("clerk_opaque_verification_start", {
      issuer,
    });
    if (
      !this.options.opaqueTokenClientId ||
      !this.options.opaqueTokenClientSecret
    ) {
      throw invalidToken("Opaque token verification is not configured");
    }

    // If the OAuth client is private, use the Basic authorization header.
    const authorization = `Basic ${base64Utf8(
      `${this.options.opaqueTokenClientId}:${this.options.opaqueTokenClientSecret}`,
    )}`;
    return verifyOpaqueAccessToken(
      token,
      issuer,
      resourceUrl,
      fetch,
      authorization,
    );
  }
}

async function verifyBackendAccessToken(
  token: string,
  issuer: string,
  resourceUrl: URL,
  fetch: HttpFetch,
  secretKey: string,
): Promise<AuthInfo> {
  const endpoint =
    "https://api.clerk.com/oauth_applications/access_tokens/verify";
  logger.info("clerk_backend_api_verification_start", { endpoint, issuer });

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: token }),
    });
  } catch (error) {
    logger.warn("clerk_backend_api_verification_request_failed", {
      endpoint,
      ...errorDetails(error),
    });
    throw invalidToken("Clerk Backend API token verification failed");
  }

  if (!response.ok) {
    logger.warn("clerk_backend_api_verification_failed", {
      endpoint,
      status: response.status,
      statusText: response.statusText,
    });
    throw invalidToken("Invalid Clerk opaque access token");
  }

  logger.info("clerk_backend_api_verification_completed", {
    endpoint,
    status: response.status,
  });

  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    logger.warn("clerk_backend_api_verification_invalid_json", {
      endpoint,
      ...errorDetails(error),
    });
    throw invalidToken("Invalid Clerk Backend API token response");
  }

  if (isClerkBackendAccessTokenInactiveResponse(result)) {
    logger.warn("clerk_backend_api_token_inactive", { endpoint });
    throw invalidToken("Inactive Clerk opaque access token");
  }

  if (!isClerkBackendAccessTokenResponse(result)) {
    logger.warn("clerk_backend_api_token_invalid_claims", { endpoint });
    throw invalidToken(
      "Clerk Backend API response has required claims missing",
    );
  }

  if (
    result.revoked ||
    result.expired ||
    result.expiration <= Date.now() / 1000
  ) {
    logger.warn("clerk_backend_api_token_inactive", {
      endpoint,
      expired: result.expired,
      revoked: result.revoked,
    });
    throw invalidToken("Inactive Clerk opaque access token");
  }

  const authInfo: AuthInfo = {
    token,
    clientId: result.client_id,
    scopes: result.scopes,
    expiresAt: result.expiration,
    resource: resourceUrl,
    extra: { userId: result.subject },
  };
  logVerifiedToken("backend", issuer, authInfo);
  return authInfo;
}

export function createClerkTokenVerifier(
  options: ClerkTokenVerifierOptions,
): OAuthTokenVerifier {
  return new ClerkTokenVerifier(options);
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
      // audience: resourceUrl.href,
      issuer,
    });

    const authInfo = toAuthInfo(token, payload, resourceUrl);
    logVerifiedToken("JWT", issuer, authInfo);
    return authInfo;
  } catch (error) {
    logger.warn("clerk_jwt_verification_failed", {
      issuer,
      ...errorDetails(error),
    });
    throw invalidToken("Invalid Clerk JWT access token");
  }
}

async function verifyOpaqueAccessToken(
  token: string,
  issuer: string,
  resourceUrl: URL,
  fetch: HttpFetch,
  authorization: string,
): Promise<AuthInfo> {
  const endpoint = `${issuer}/oauth/token_info`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (error) {
    logger.warn("clerk_opaque_introspection_request_failed", {
      endpoint,
      ...errorDetails(error),
    });
    throw invalidToken("Clerk opaque token introspection failed");
  }

  if (!response.ok) {
    logger.warn("clerk_opaque_introspection_failed", {
      endpoint,
      status: response.status,
      statusText: response.statusText,
      body: await response.text(),
    });
    throw invalidToken("Invalid Clerk opaque access token");
  }

  logger.info("clerk_opaque_introspection_completed", {
    endpoint,
    status: response.status,
  });

  let result: ClerkIntrospectionResponse;
  try {
    result = (await response.json()) as ClerkIntrospectionResponse;
  } catch (error) {
    logger.warn("clerk_opaque_introspection_invalid_json", {
      endpoint,
      ...errorDetails(error),
    });
    throw invalidToken("Invalid Clerk opaque-token response");
  }

  if (result.active !== true) {
    logger.warn("clerk_opaque_token_inactive", { endpoint });
    throw invalidToken("Inactive Clerk opaque access token");
  }

  logger.info("clerk_opaque_introspection_result", {
    endpoint,
    result,
  });

  // if (result.resource !== resourceUrl.href) {
  //   logger.warn("clerk_opaque_token_resource_mismatch", {
  //     endpoint,
  //     expectedResource: resourceUrl.href,
  //     hasResource: typeof result.resource === "string",
  //   });
  //   throw invalidToken("Clerk opaque access token has an invalid resource");
  // }
  // {
  //   active: true,
  //   client_id: "yfMg1LZpgfvyxtY5",
  //   iat: 1787890333,
  //   scope: "offline_access users:read openid profile email",
  //   sub: "user_2WmGvirCeic7h9XFQznaJXB4gkr",
  // },

  try {
    const authInfo = toAuthInfo(token, result, resourceUrl);
    logVerifiedToken("opaque", issuer, authInfo);
    return authInfo;
  } catch (error) {
    logger.warn("clerk_opaque_token_invalid_claims", {
      endpoint,
      ...errorDetails(error),
    });
    throw error;
  }
}

function toAuthInfo(
  token: string,
  claims: JWTPayload | ClerkIntrospectionResponse,
  resource: URL,
): AuthInfo {
  const clientId = readClientId(claims);

  // jwt
  let expiresAt: number | undefined;
  if ("exp" in claims && typeof claims.exp === "number") {
    expiresAt = claims.exp;
  } else {
    // Opaque token introspection does not include an expiry. The MCP SDK
    // requires Unix seconds, so use a limited server-side lifetime.
    expiresAt = Math.floor(Date.now() / 1000) + 8 * 60 * 60;
  }

  if (!clientId) {
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
    expiresAt: expiresAt,
    resource,
    extra: { userId },
  };
}

function readClientId(
  claims: JWTPayload | ClerkIntrospectionResponse,
): string | undefined {
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

function isClerkBackendAccessTokenResponse(
  value: unknown,
): value is ClerkBackendAccessTokenResponse {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    typeof result.client_id === "string" &&
    typeof result.subject === "string" &&
    Array.isArray(result.scopes) &&
    result.scopes.every((scope) => typeof scope === "string") &&
    typeof result.revoked === "boolean" &&
    typeof result.expired === "boolean" &&
    typeof result.expiration === "number" &&
    Number.isFinite(result.expiration)
  );
}

function isClerkBackendAccessTokenInactiveResponse(
  value: unknown,
): value is { active: false } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).active === false
  );
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

function logVerifiedToken(
  tokenType: "JWT" | "opaque" | "backend",
  issuer: string,
  authInfo: AuthInfo,
) {
  logger.info("clerk_token_verified", {
    tokenType,
    issuer,
    clientId: authInfo.clientId,
    scopes: authInfo.scopes,
    expiresAt: authInfo.expiresAt,
  });
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error === null || typeof error !== "object") {
    return { errorType: typeof error };
  }

  const candidate = error as {
    claim?: unknown;
    code?: unknown;
    name?: unknown;
  };
  return {
    errorType: typeof candidate.name === "string" ? candidate.name : "Error",
    ...(typeof candidate.code === "string" && { errorCode: candidate.code }),
    ...(typeof candidate.claim === "string" && { claim: candidate.claim }),
  };
}
