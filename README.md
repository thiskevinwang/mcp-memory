# mcp-memory

This MCP 2.0 Streamable HTTP server is a Clerk OAuth protected resource. It
gives an agent two authenticated memory tools:

- `remember` creates an embedding and persists the vector, original text, and
  creation date.
- `recall` embeds a natural-language query and returns the nearest memories.

Memories use a SHA-256 digest of the Clerk user ID as the Vectorize namespace.
One user cannot search another user's memories.

## Configure Clerk

Create custom Clerk OAuth scopes named `users:read` and `users:create`.
Enable Dynamic Client Registration for MCP clients that need it. Set `users:read` as a default scope. The server rejects every `/mcp` request that lacks `users:read`.

`users:create` is advertised for the first Clerk user-creation tool. No such tool exists yet. That tool must require `users:create` before it calls the Clerk Backend API.

## Configure the server

Create a local `.dev.vars` file. Do not commit this file. Wrangler loads this
file during `bun run dev`.

```sh
CLERK_ISSUER=https://your-instance.clerk.accounts.dev
MCP_RESOURCE_URL=http://localhost:8787/mcp
CLERK_SECRET_KEY=your-clerk-secret-key

# Required only when Clerk issues opaque OAuth access tokens.
CLERK_OAUTH_CLIENT_ID=your-resource-server-client-id
CLERK_OAUTH_CLIENT_SECRET=your-resource-server-client-secret
```

`CLERK_ISSUER` must be the exact `issuer` value from the Clerk authorization-server metadata. JWT tokens use that issuer's JWKS and RS256 signature. Their `aud` claim must equal `MCP_RESOURCE_URL`, and their `sub` claim must identify a Clerk user. Opaque tokens use `${CLERK_ISSUER}/oauth/token_info`; the response must be active, contain the same resource URL, and identify a Clerk user.

## Create the Vectorize index

The `@cf/qwen/qwen3-embedding-0.6b` Workers AI model produces
1,024-dimensional embeddings. Create the index
with the same dimensions and cosine distance:

```sh
bunx wrangler vectorize create mcp-memory-qwen3 --dimensions=1024 --metric=cosine
bunx wrangler vectorize create-metadata-index mcp-memory-qwen3 \
  --property-name=createdAtDay --type=number
```

The metadata index enables the optional `maxAgeDays` filter on `recall`. Create
it before the first memory write. Vectorize applies writes asynchronously, so a
new memory can take a short time to appear in similarity results.

See Cloudflare's [Vectorize and Workers AI guide](https://developers.cloudflare.com/vectorize/get-started/embeddings/)
for the binding and embedding flow.

## Run and test

```sh
bun run dev
bun run test
bun run typecheck
```

The public OAuth metadata endpoint is:

```text
http://localhost:8787/.well-known/oauth-protected-resource/mcp
```

The MCP client uses `http://localhost:8787/mcp`. This local URL works only when the client and server run on the same computer.

## Deploy

Set each required value as a Worker secret before deployment. Do not put secret
values in `wrangler.jsonc`.

```sh
bunx wrangler secret put CLERK_ISSUER
bunx wrangler secret put MCP_RESOURCE_URL
bunx wrangler secret put CLERK_SECRET_KEY
bunx wrangler secret put CLERK_OAUTH_CLIENT_ID
bunx wrangler secret put CLERK_OAUTH_CLIENT_SECRET
bun run deploy
```

Set `MCP_RESOURCE_URL` to the final public HTTPS URL ending in `/mcp`. The
value must match the `aud` claim in Clerk JWT access tokens.
