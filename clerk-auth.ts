import { createClerkClient, type ClerkClient } from "@clerk/backend";

import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";

interface Options {
  secretKey: string;
  publishableKey: string;
}

export class ClerkAuth implements OAuthTokenVerifier {
  private readonly clerk: ClerkClient;
  private readonly pk: string;

  constructor(options: Options) {
    if (!options.publishableKey)
      throw new Error("ClerkAuth: publishableKey is required");
    if (!options.secretKey) throw new Error("ClerkAuth: secretKey is required");

    this.pk = options.publishableKey;
    this.clerk = createClerkClient({
      publishableKey: options.publishableKey,
      secretKey: options.secretKey,
    });
  }

  get fapiURL() {
    const encodedDomain = this.pk.split("_").at(-1);
    if (!encodedDomain)
      throw new Error("ClerkAuth.fapiURL: invalid publisahbleKey");
    const domain = atob(encodedDomain);
    if (!domain.endsWith("$"))
      throw new Error(
        "ClerkAuth.fapiURL: publisahbleKey decoded to invalid value",
      );
    return new URL(`https://${domain.slice(0, -1)}`);
  }

  metadata?: OAuthMetadata;
  async getOAuthMetadata(): Promise<OAuthMetadata> {
    const url = new URL(".well-known/oauth-authorization-server", this.fapiURL);
    this.metadata ??= await fetch(url).then((res) => res.json());
    return this.metadata;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const res = await this.clerk.idPOAuthAccessToken.verify(token);
      return {
        token: token,
        clientId: res.clientId,
        scopes: res.scopes,
        expiresAt: res.expiration || undefined,
        extra: {
          userId: res.subject,
        },
      };
    } catch (err) {
      console.error("verifyAccessToken:", err);
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
    }
  }
}

// remarks:
// - IdPOAuthAccessToken.expiration type says unix milliseconds, but it's actually seconds.
