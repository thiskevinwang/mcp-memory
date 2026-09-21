# mcp-memory

This is an MCP server built on [`@modelcontextprotocol/server` V2](https://ts.sdk.modelcontextprotocol.io/v2/)

This MCP server allows certain unauthenticated operations, like discovery and tool listing, and won't immediately return an auth challenge.

## Tools

Listing the tools is a public action.

Certain tools require auth, and will challenge the client.

| Tool | Requires Auth | Description | 
| :--- | :--- | :--- |
| `whoami` | ❌ | Displays info about the subject. Returns empty fields if not authenticated |
| `recall` | ✅ | Recalls _memories_ in order similarity to a given input query |
| `capture` | ✅ | Persists a given input as a _memory_. |


### Memory

This server implements a "memory" interface, but that is really secondary to the auth pieces of this project.

This interface and implementation are 100% AI written, as I was not focused on this part of the code.

## Authentication & Authorization 

This part of the code is 100% human written because:

1. I wanted to write this by hand.
1. I wanted to land on a super lean integration — something that felt _right_, to me as a human.
1. I ran out of Codex credits.

Authentication is powered by clerk. The token verifier implements [MCP's `OAuthTokenVerifier`.](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html#require-a-bearer-token)

And as stated above, auth is _conditionally enforced_ across this MCP server. See the access control list (ACL) in [acl.ts](./acl.ts) for access policy.

Data is namespaced by authenticated user id.