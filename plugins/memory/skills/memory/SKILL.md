---
name: memory
description: Recall relevant user memories and save durable facts, preferences, and decisions with the mcp-memory MCP server.
---

# Memory

Use the `mcp-memory` MCP server tools when persistent user context can improve the result.

## Recall

- Before work that depends on user preferences, prior decisions, project history, or repeated workflows, call `recall`.
- Write a specific natural-language query. Include the subject, goal, and useful constraints.
- Use `limit: 5` by default. Use a smaller limit when only one fact is needed.
- Use `maxAgeDays` when recent context matters. Omit it for durable facts.
- Treat no results as no known memory. Do not invent missing context.
- Check recalled text for relevance before using it. Similarity is not proof.

## Capture

- Call `capture` after the user states a durable preference, confirms a design decision, establishes project context, or gives a reusable workflow rule.
- Store one clear fact or decision per memory. Keep the original meaning and enough context to avoid ambiguity.
- Do not store passwords, tokens, private keys, financial account data, or other sensitive data unless the user explicitly requests it.
- Do not store temporary task details, guesses, or facts that are useful only for the current turn.
- Do not store a memory only because a response sounds plausible. Store user-provided or user-confirmed information.

## Tool use

- `recall` is read-only and returns text, creation date, and similarity score.
- `capture` persists text and returns an ID and creation date.
- User memories are isolated by authenticated user. Never claim access to another user's memories.
- If the server is unavailable or unauthenticated, report the exact limitation and continue without memory when safe.
- After saving a memory, briefly confirm what was saved. Do not expose internal IDs unless useful.

## Response behavior

- Use recalled context silently when it directly helps.
- Mention recalled context when it changes a recommendation or prevents a likely mistake.
- Ask before saving an inferred preference or a sensitive detail.
- Never claim that a fact was remembered unless the `capture` tool call succeeded.
