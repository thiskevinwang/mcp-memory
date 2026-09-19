# mcp-memory

This is an MCP server built on `@modelcontextprotocol/server` V2.

## Tools

This MCP server provides two tools:

- `recall`: recalls _memories_ in order similarity to a given input query
- `capture`: persists a given input as a _memory_.

### Memory store

This interface and implementation are 100% AI written, as I was not focused on this part of the code.

## Authentication & Authorization 

This part of the code is 100% human written because:

1. I wanted to land a super lean integration — something that could eventually be exported from `@clerk/mcp-tools`
1. I ran out of Codex credits.
1. I wanted to write this by band.

Authentication is powered by clerk.

Any authorized user may use the provided tools.

Data is namespaced by authenticated user id so there's no cross-user data access.