# Copilot Instructions: mcp-memory

Read `~/.codex/AGENTS.md` first. Follow those global instructions, then these repository instructions.

## Project Overview

This is a Cloudflare Worker that implements an MCP 2.0 Streamable HTTP server providing OAuth-protected memory tools. It uses:
- **Clerk OAuth** for authentication and authorization
- **Workers AI** (Qwen3 embedding model) for generating vector embeddings
- **Vectorize** for storing and searching memory vectors
- **Hono** as the web framework with MCP server middleware

## Build, Test, and Typecheck

```bash
# Start development server (local with Miniflare)
bun run dev

# Run all tests
bun run test

# Run typecheck (generates Workers types, then runs tsc)
bun run typecheck

# Deploy to Cloudflare Workers
bun run deploy
```

### Running a Single Test

Bun supports test filtering:
```bash
# Run tests matching a pattern
bun test --test-name-pattern "remember tool"

# Run a specific test file
bun test index.test.ts
```

### Task Commands

The project uses [Taskfile](https://taskfile.dev/) for common workflows:
```bash
task dev        # Start dev server
task inspector  # Launch MCP Inspector at http://localhost:8787/mcp
```

## Architecture

### Core Components

1. **index.ts** - Entry point that creates the protected MCP app
   - Exports Cloudflare Worker handler
   - Wires together authentication, memory store, and MCP server
   - Uses `createProtectedMcpApp()` to configure OAuth and MCP handlers

2. **clerk-token-verifier.ts** - Clerk OAuth token verification
   - Supports JWT access tokens (RS256 with JWKS verification)
   - Supports opaque access tokens (via Clerk introspection or Backend API)
   - Returns `AuthInfo` with `userId` in `extra` field

3. **memory-store.ts** - Vector memory operations
   - `VectorMemoryStore` class handles persist/recall operations
   - Uses SHA-256 hash of Clerk user ID as Vectorize namespace
   - Embeddings created via Workers AI `@cf/qwen/qwen3-embedding-0.6b`
   - Supports optional `maxAgeDays` filter using `createdAtDay` metadata index

### MCP Tools

The server registers two MCP tools:

1. **remember** - Persist text as a dated memory
   - Input: `text` (max 2,000 chars)
   - Output: `{ id, createdAt }`
   - Creates embedding and stores in Vectorize

2. **recall** - Find memories by vector similarity
   - Input: `query`, `limit` (1-20, default 5), `maxAgeDays` (optional)
   - Output: `{ memories: [{ id, text, createdAt, score }] }`
   - Searches using query embedding

### Authentication Flow

1. Client sends Bearer token in Authorization header
2. `requireBearerAuth` middleware verifies token via Clerk
3. Token must include `users:read` scope (plus OIDC standard scopes)
4. Token's `aud` must match `MCP_RESOURCE_URL`
5. User ID from token must match `ALLOWED_USER_ID` (single-user enforcement)
6. If all checks pass, request reaches MCP handler

### Environment Variables

Required secrets (set via `wrangler secret put`):
- `CLERK_SECRET_KEY` - Clerk secret key for Backend API verification
- `CLERK_OAUTH_CLIENT_ID` - OAuth client ID for opaque token introspection
- `CLERK_OAUTH_CLIENT_SECRET` - OAuth client secret for opaque token introspection

Public vars (in `wrangler.jsonc` or `.dev.vars`):
- `CLERK_ISSUER` - Clerk issuer URL (e.g., `https://clerk.example.com`)
- `MCP_RESOURCE_URL` - This server's MCP endpoint URL (must match JWT `aud`)
- `ALLOWED_USER_ID` - Single Clerk user ID permitted to use this server
- `ALLOWED_HOSTS` - Comma-separated list of allowed hostnames

### Vectorize Index Configuration

The Vectorize index must be created with:
- **Dimensions**: 1024 (matches Qwen3 embedding model output)
- **Metric**: cosine
- **Metadata index**: `createdAtDay` (number) for date filtering

```bash
bunx wrangler vectorize create mcp-memory-qwen3 --dimensions=1024 --metric=cosine
bunx wrangler vectorize create-metadata-index mcp-memory-qwen3 \
  --property-name=createdAtDay --type=number
```

## Key Conventions

### User Namespace Isolation

Each user's memories are stored in a Vectorize namespace derived from their Clerk user ID:
```typescript
namespace = SHA256(userId) // hex-encoded
```

This ensures one user cannot search another user's memories. All vector operations (upsert, query) use this namespace.

### Embedding Purposes

The embedding model is called with different purposes:
- `"document"` - when persisting a new memory (uses `documents` input field)
- `"query"` - when searching memories (uses `queries` input field)

This distinction may improve relevance if the model supports purpose-specific embeddings.

### Memory Metadata

Each vector in Vectorize stores:
- `text` (string) - original memory text
- `createdAt` (string) - ISO 8601 timestamp
- `createdAtDay` (number) - epoch day number (for filtering)

The `createdAtDay` field enables efficient date-range filtering without parsing ISO strings.

### Test Structure

Tests use Bun's built-in test runner. Mock implementations:
- `tokenVerifier` - for bypassing real Clerk verification
- `memoryStore` - for capturing persist/recall calls without real Vectorize

Persistent tracking arrays (`persistedMemoryCalls`, `recalledMemoryCalls`) allow assertions on tool invocations.

### Logging

Uses LogTape with category-based logging:
- `["hono", "auth", "clerk"]` - Clerk token verification events
- `["hono", "auth", "mcp"]` - MCP request authorization decisions

Console output switches between human-readable and JSON Lines based on runtime detection.

## OAuth Metadata Endpoint

The server exposes OAuth Protected Resource metadata at:
```
/.well-known/oauth-protected-resource/mcp
```

Returns:
```json
{
  "resource": "https://..../mcp",
  "authorization_servers": ["https://clerk.example.com"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["users:read", "users:write"]
}
```

This allows MCP clients to discover authorization server and required scopes.

## Cloudflare Workers Bindings

Bindings are configured in `wrangler.jsonc`:
- `AI` - Workers AI binding (remote mode)
- `MEMORIES` - Vectorize index binding (remote mode, points to `mcp-memory-qwen3`)

Access via `env.AI` and `env.MEMORIES` in the Worker handler.

## Local Development

Local dev uses Miniflare for emulation. Create `.dev.vars` (git-ignored) with required environment variables. The dev server runs at `http://localhost:8787`.

Use `task inspector` to open the MCP Inspector for interactive testing of MCP tools.

## MISSION.md Context

The project is in early development phase. The current goal is to understand and test Clerk authorization workflows via MCP without manual dashboard work. This is a test/development tool, not production-ready.
