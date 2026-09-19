const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const MILLISECONDS_PER_DAY = 86_400_000;

export const MAX_MEMORY_TEXT_LENGTH = 2_000;
export const MAX_RECALL_RESULTS = 20;

export interface PersistedMemory {
  id: string;
  createdAt: string;
}

export interface RecalledMemory {
  id: string;
  text: string;
  createdAt: string;
  score: number;
}

export interface RecallOptions {
  limit: number;
  maxAgeDays?: number;
}

export interface MemoryStore {
  persistMemory(userId: string, text: string): Promise<PersistedMemory>;
  recallMemories(
    userId: string,
    query: string,
    options: RecallOptions,
  ): Promise<RecalledMemory[]>;
}

interface VectorStoreClient {
  upsert(
    vectors: VectorizeVector[],
  ): Promise<VectorizeAsyncMutation | VectorizeVectorMutation>;
  query(
    vector: number[],
    options: VectorizeQueryOptions,
  ): Promise<VectorizeMatches>;
}

interface VectorMemoryStoreOptions {
  createEmbedding(
    text: string,
    purpose: "document" | "query",
  ): Promise<number[]>;
  index: VectorStoreClient;
  now?: () => Date;
  createId?: () => string;
}

export class VectorMemoryStore implements MemoryStore {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: VectorMemoryStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async persistMemory(userId: string, text: string): Promise<PersistedMemory> {
    const id = this.createId();
    const createdAt = this.now().toISOString();
    await this.upsertMemory(userId, id, text, createdAt);
    return { id, createdAt };
  }

  async upsertMemory(
    userId: string,
    id: string,
    text: string,
    createdAt: string,
  ): Promise<void> {
    validateText("Memory text", text);
    const createdAtDate = new Date(createdAt);
    if (Number.isNaN(createdAtDate.getTime())) {
      throw new Error("Memory creation date must be ISO 8601");
    }

    const [values, namespace] = await Promise.all([
      this.options.createEmbedding(text, "document"),
      createUserNamespace(userId),
    ]);
    await this.options.index.upsert([
      {
        id,
        values,
        namespace,
        metadata: {
          text,
          createdAt,
          createdAtDay: toEpochDay(createdAtDate),
        },
      },
    ]);
  }

  async recallMemories(
    userId: string,
    query: string,
    options: RecallOptions,
  ): Promise<RecalledMemory[]> {
    validateText("Memory query", query);
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_RECALL_RESULTS
    ) {
      throw new RangeError(
        `Recall limit must be from 1 through ${MAX_RECALL_RESULTS}`,
      );
    }

    const [values, namespace] = await Promise.all([
      this.options.createEmbedding(query, "query"),
      createUserNamespace(userId),
    ]);
    const filter =
      options.maxAgeDays === undefined
        ? undefined
        : {
            createdAtDay: {
              $gte: toEpochDay(
                new Date(
                  this.now().getTime() -
                    options.maxAgeDays * MILLISECONDS_PER_DAY,
                ),
              ),
            },
          };
    const result = await this.options.index.query(values, {
      topK: options.limit,
      namespace,
      returnValues: false,
      returnMetadata: "all",
      ...(filter && { filter }),
    });

    return result.matches.flatMap((match) => {
      const memory = readMemoryMatch(match);
      return memory ? [memory] : [];
    });
  }
}

interface D1BackedMemoryStoreOptions {
  database: D1Database;
  vectors: VectorMemoryStore;
  now?: () => Date;
  createId?: () => string;
}

export class D1BackedMemoryStore implements MemoryStore {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: D1BackedMemoryStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async persistMemory(userId: string, text: string): Promise<PersistedMemory> {
    validateText("Memory text", text);
    const id = this.createId();
    const createdAt = this.now().toISOString();
    await this.insertRecord(userId, id, text, createdAt);
    try {
      await this.options.vectors.upsertMemory(userId, id, text, createdAt);
    } catch (error) {
      await this.compensate(
        () => this.deleteRecord(userId, id),
        "persist_memory_compensation_failed",
        id,
      );
      throw error;
    }
    return { id, createdAt };
  }

  recallMemories(
    userId: string,
    query: string,
    options: RecallOptions,
  ): Promise<RecalledMemory[]> {
    return this.options.vectors.recallMemories(userId, query, options);
  }

  private async insertRecord(
    userId: string,
    id: string,
    text: string,
    createdAt: string,
  ): Promise<void> {
    await this.options.database
      .prepare(
        `INSERT INTO memories
         (id, user_id, text, created_at, updated_at, relevance)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        userId,
        text,
        createdAt,
        createdAt,
        null,
      )
      .run();
  }

  private async deleteRecord(userId: string, id: string): Promise<void> {
    await this.options.database
      .prepare("DELETE FROM memories WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
  }

  private async compensate(
    action: () => Promise<void>,
    message: string,
    id: string,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      console.error(
        JSON.stringify({
          message,
          memoryId: id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

export function createCloudflareMemoryStore(
  ai: Ai,
  index: Vectorize | VectorizeIndex,
  database: D1Database,
): MemoryStore {
  const vectors = new VectorMemoryStore({
    index,
    async createEmbedding(text, purpose) {
      const input =
        purpose === "query" ? { queries: [text] } : { documents: [text] };
      const result = await ai.run(EMBEDDING_MODEL, input);
      if (!("data" in result) || !Array.isArray(result.data?.[0])) {
        throw new Error("Workers AI did not return an embedding");
      }
      return result.data[0];
    },
  });
  return new D1BackedMemoryStore({ database, vectors });
}

async function createUserNamespace(userId: string): Promise<string> {
  if (!userId) {
    throw new Error("A Clerk user ID is required");
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(userId),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function validateText(label: string, value: string) {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.length > MAX_MEMORY_TEXT_LENGTH) {
    throw new Error(
      `${label} must have at most ${MAX_MEMORY_TEXT_LENGTH} characters`,
    );
  }
}

function toEpochDay(date: Date) {
  return Math.floor(date.getTime() / MILLISECONDS_PER_DAY);
}

function readMemoryMatch(match: VectorizeMatch): RecalledMemory | undefined {
  const metadata = match.metadata;
  if (
    !metadata ||
    typeof metadata.text !== "string" ||
    typeof metadata.createdAt !== "string"
  ) {
    return undefined;
  }

  return {
    id: match.id,
    text: metadata.text,
    createdAt: metadata.createdAt,
    score: match.score,
  };
}
