---
name: run-mcp-memory
description: Run and verify this MCP Memory Cloudflare Worker with remote Workers AI and Vectorize bindings, or in local-only mode without remote bindings. Use when asked to start the server, choose a development mode, test MCP or OAuth locally, open MCP Inspector, or diagnose local startup.
---

# Run MCP Memory

Use the bundled runner. Keep the Worker process in the foreground unless a short verification needs a temporary background process.

## Select a mode

- Use `remote` when `remember` or `recall` must work. The Worker runs locally. Workers AI and Vectorize use the configured Cloudflare resources. This mode can cause Cloudflare usage.
- Use `local` for OAuth metadata, authentication routing, MCP transport, or startup work without remote bindings. Workers AI and Vectorize have no local simulation. Do not claim that `remember` or `recall` works in this mode.
- Ask for a mode only when the request does not show whether memory tools are needed. Otherwise, select the applicable mode.

## Protect resources and secrets

- Never print values from `.dev.vars`.
- Never create, delete, or replace the Vectorize index unless the user explicitly requests that action.
- Never kill an unrelated process when port `8787` is busy. Report the process conflict.

## Start the server

From the repository root, run:

```sh
.agents/skills/run-mcp-memory/scripts/run.sh remote
```

or:

```sh
.agents/skills/run-mcp-memory/scripts/run.sh local
```

Pass extra Wrangler development options after the mode. Example:

```sh
.agents/skills/run-mcp-memory/scripts/run.sh local --log-level debug
```

The runner checks required local files and secret names. If dependencies are missing, run `bun install` only when dependency installation is in scope.

## Verify startup

Wait for Wrangler to report its local URL. Then check the public OAuth metadata endpoint:

```sh
curl -fsS http://localhost:8787/.well-known/oauth-protected-resource/mcp
```

For interactive MCP testing, keep the server active and run this in a second terminal:

```sh
bunx @modelcontextprotocol/inspector --url http://localhost:8787/mcp
```

Only say that remote memory access works after a successful authenticated `remember` or `recall` call. A successful metadata request verifies startup and routing only.

## Stop temporary runs

Stop any server started only for verification. Leave a requested development server active and report its URL, mode, and process state.
