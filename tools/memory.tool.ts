import * as z from "zod/v4";

import type { McpServer, AuthInfo } from "@modelcontextprotocol/server";

import {
  MAX_MEMORY_TEXT_LENGTH,
  MAX_RECALL_RESULTS,
  type MemoryStore,
} from "@/tools/memory.store";

export function registerMemoryTools(
  server: McpServer,
  memoryStore: MemoryStore,
) {
  server.registerTool(
    "capture",
    {
      description: "Persist text as a dated memory for the authenticated user.",
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .max(MAX_MEMORY_TEXT_LENGTH)
          .describe("Original memory text to persist"),
      }),
      outputSchema: z.object({
        id: z.string(),
        createdAt: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }, ctx) => {
      const memory = await memoryStore.persistMemory(
        requireClerkUserId(ctx.http?.authInfo),
        text,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(memory) }],
        structuredContent: memory,
      };
    },
  );

  server.registerTool(
    "recall",
    {
      description:
        "Find memories for the authenticated user. Returns original text, creation date, and similarity score.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(MAX_MEMORY_TEXT_LENGTH)
          .describe("Natural-language similarity query"),
        limit: z.number().int().min(1).max(MAX_RECALL_RESULTS).default(5),
        maxAgeDays: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Only return memories from this many recent days"),
      }),
      outputSchema: z.object({
        memories: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            createdAt: z.string(),
            score: z.number(),
          }),
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit, maxAgeDays }, ctx) => {
      const memories = await memoryStore.recallMemories(
        requireClerkUserId(ctx.http?.authInfo),
        query,
        { limit, maxAgeDays },
      );
      const result = { memories };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}

function requireClerkUserId(authInfo: AuthInfo | undefined) {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) {
    throw new Error("Authenticated Clerk user ID is required");
  }
  return userId;
}
