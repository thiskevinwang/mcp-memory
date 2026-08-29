import { describe, expect, test } from "bun:test";

import { VectorMemoryStore } from "./memory-store";

const createdAt = new Date("2026-08-28T12:34:56.000Z");
const userNamespace =
  "80fba0ae1c48e3978e43e4efc365e14e12ea0c830ba8ba5b9a2dafc7e3f2ab8b";

describe("Vector memory store", () => {
  test("persists the embedding, original text, and creation date", async () => {
    const upserts: VectorizeVector[][] = [];
    const store = new VectorMemoryStore({
      createEmbedding: async (text, purpose) => {
        expect(text).toBe("The launch date is October 4.");
        expect(purpose).toBe("document");
        return [0.1, 0.2, 0.3];
      },
      index: {
        async upsert(vectors) {
          upserts.push(vectors);
          return { mutationId: "mutation-123" };
        },
        async query() {
          return { matches: [], count: 0 };
        },
        async deleteByIds() {
          return { mutationId: "unused" };
        },
      },
      now: () => createdAt,
      createId: () => "memory-123",
    });

    await expect(
      store.persistMemory("user_123", "The launch date is October 4."),
    ).resolves.toEqual({
      id: "memory-123",
      createdAt: "2026-08-28T12:34:56.000Z",
    });
    expect(upserts).toEqual([
      [
        {
          id: "memory-123",
          values: [0.1, 0.2, 0.3],
          namespace: userNamespace,
          metadata: {
            text: "The launch date is October 4.",
            createdAt: "2026-08-28T12:34:56.000Z",
            createdAtDay: 20_693,
          },
        },
      ],
    ]);
  });

  test("retrieves similar memories in the user namespace with a recency filter", async () => {
    const queries: Array<{
      vector: number[];
      options: VectorizeQueryOptions;
    }> = [];
    const store = new VectorMemoryStore({
      createEmbedding: async (text, purpose) => {
        expect(text).toBe("When is launch?");
        expect(purpose).toBe("query");
        return [0.4, 0.5, 0.6];
      },
      index: {
        async upsert() {
          return { mutationId: "unused" };
        },
        async query(vector, options) {
          queries.push({ vector, options });
          return {
            count: 1,
            matches: [
              {
                id: "memory-123",
                namespace: userNamespace,
                score: 0.92,
                metadata: {
                  text: "The launch date is October 4.",
                  createdAt: "2026-08-20T09:00:00.000Z",
                  createdAtDay: 20_685,
                },
              },
            ],
          };
        },
        async deleteByIds() {
          return { mutationId: "unused" };
        },
      },
      now: () => createdAt,
    });

    await expect(
      store.recallMemories("user_123", "When is launch?", {
        limit: 3,
        maxAgeDays: 30,
      }),
    ).resolves.toEqual([
      {
        id: "memory-123",
        text: "The launch date is October 4.",
        createdAt: "2026-08-20T09:00:00.000Z",
        score: 0.92,
      },
    ]);
    expect(queries).toEqual([
      {
        vector: [0.4, 0.5, 0.6],
        options: {
          topK: 3,
          namespace: userNamespace,
          returnValues: false,
          returnMetadata: "all",
          filter: { createdAtDay: { $gte: 20_663 } },
        },
      },
    ]);
  });

  test("uses different namespaces for different Clerk users", async () => {
    const namespaces: string[] = [];
    const store = new VectorMemoryStore({
      createEmbedding: async () => [0.1],
      index: {
        async upsert(vectors) {
          namespaces.push(vectors[0].namespace ?? "");
          return { mutationId: "mutation" };
        },
        async query() {
          return { matches: [], count: 0 };
        },
        async deleteByIds() {
          return { mutationId: "unused" };
        },
      },
      now: () => createdAt,
      createId: () => "memory",
    });

    await store.persistMemory("user_123", "First user memory");
    await store.persistMemory("user_456", "Second user memory");

    expect(namespaces[0]).toHaveLength(64);
    expect(namespaces[1]).toHaveLength(64);
    expect(namespaces[0]).not.toBe(namespaces[1]);
  });
});
