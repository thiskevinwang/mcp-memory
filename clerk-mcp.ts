import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { fapiUrlFromPublishableKey } from "@clerk/backend/proxy";

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
    this.pk = options.publishableKey;
    this.clerk = createClerkClient({
      publishableKey: options.publishableKey,
      secretKey: options.secretKey,
    });
  }

  get fapiURL() {
    return fapiUrlFromPublishableKey(this.pk);
  }

  metadata?: OAuthMetadata;
  async getOAuthMetadata(): Promise<OAuthMetadata> {
    const url = new URL(".well-known/oauth-authorization-server", this.fapiURL);
    console.log("fetching", url);
    this.metadata ??= await fetch(url).then((res) => res.json());
    console.log("fetched", url);
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
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
    }
  }
}

// remarks:
// - IdPOAuthAccessToken.expiration type says unix milliseconds, but it's actually seconds.
