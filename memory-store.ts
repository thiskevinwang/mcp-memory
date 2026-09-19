const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const MILLISECONDS_PER_DAY = 86_400_000;
const ADMIN_PAGE_SIZE = 50;

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

export interface AdminMemory {
  id: string;
  userId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  relevance: number | null;
  score?: number;
}

export interface AdminMemoryPage {
  memories: AdminMemory[];
  page: number;
  hasNextPage: boolean;
}

interface VectorStoreClient {
  upsert(
    vectors: VectorizeVector[],
  ): Promise<VectorizeAsyncMutation | VectorizeVectorMutation>;
  query(
    vector: number[],
    options: VectorizeQueryOptions,
  ): Promise<VectorizeMatches>;
  deleteByIds(
    ids: string[],
  ): Promise<VectorizeAsyncMutation | VectorizeVectorMutation>;
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

  async deleteMemory(id: string): Promise<void> {
    await this.options.index.deleteByIds([id]);
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

interface MemoryRow {
  id: string;
  user_id: string;
  text: string;
  created_at: string;
  updated_at: string;
  relevance: number | null;
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
    const record: AdminMemory = {
      id,
      userId,
      text,
      createdAt,
      updatedAt: createdAt,
      relevance: null,
    };
    await this.insertRecord(record);
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

  async listMemories(
    userId: string,
    options: { page: number; filter?: string },
  ): Promise<AdminMemoryPage> {
    const page = normalizePage(options.page);
    const filter = options.filter?.trim() ?? "";
    const offset = (page - 1) * ADMIN_PAGE_SIZE;
    const statement = filter
      ? this.options.database
          .prepare(
            `SELECT id, user_id, text, created_at, updated_at, relevance
             FROM memories
             WHERE user_id = ? AND text LIKE ? ESCAPE '\\'
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`,
          )
          .bind(userId, `%${escapeLike(filter)}%`, ADMIN_PAGE_SIZE + 1, offset)
      : this.options.database
          .prepare(
            `SELECT id, user_id, text, created_at, updated_at, relevance
             FROM memories
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`,
          )
          .bind(userId, ADMIN_PAGE_SIZE + 1, offset);
    const result = await statement.all<MemoryRow>();
    return {
      memories: result.results.slice(0, ADMIN_PAGE_SIZE).map(toAdminMemory),
      page,
      hasNextPage: result.results.length > ADMIN_PAGE_SIZE,
    };
  }

  async searchMemories(userId: string, query: string): Promise<AdminMemory[]> {
    const hits = await this.options.vectors.recallMemories(userId, query, {
      limit: MAX_RECALL_RESULTS,
    });
    const rows = await this.getRecords(
      userId,
      hits.map((hit) => hit.id),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = hits.filter((hit) => !byId.has(hit.id));

    if (missing.length > 0) {
      const repairs = missing.map((hit) =>
        this.options.database
          .prepare(
            `INSERT OR IGNORE INTO memories
             (id, user_id, text, created_at, updated_at, relevance)
             VALUES (?, ?, ?, ?, ?, NULL)`,
          )
          .bind(hit.id, userId, hit.text, hit.createdAt, hit.createdAt),
      );
      await this.options.database.batch(repairs);
    }

    return hits.map((hit) => {
      const row = byId.get(hit.id);
      return row
        ? { ...toAdminMemory(row), score: hit.score }
        : {
            id: hit.id,
            userId,
            text: hit.text,
            createdAt: hit.createdAt,
            updatedAt: hit.createdAt,
            relevance: null,
            score: hit.score,
          };
    });
  }

  async updateMemoryText(
    userId: string,
    id: string,
    text: string,
  ): Promise<boolean> {
    validateText("Memory text", text);
    const previous = await this.getRecord(userId, id);
    if (!previous) return false;

    const updatedAt = this.now().toISOString();
    await this.options.database
      .prepare(
        `UPDATE memories SET text = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .bind(text, updatedAt, id, userId)
      .run();
    try {
      await this.options.vectors.upsertMemory(
        userId,
        id,
        text,
        previous.created_at,
      );
    } catch (error) {
      await this.compensate(
        () =>
          this.options.database
            .prepare(
              `UPDATE memories SET text = ?, updated_at = ?
               WHERE id = ? AND user_id = ?`,
            )
            .bind(previous.text, previous.updated_at, id, userId)
            .run()
            .then(() => undefined),
        "update_memory_compensation_failed",
        id,
      );
      throw error;
    }
    return true;
  }

  async updateMemoryRelevance(
    userId: string,
    id: string,
    relevance: number | null,
  ): Promise<boolean> {
    validateRelevance(relevance);
    const result = await this.options.database
      .prepare(
        `UPDATE memories SET relevance = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .bind(relevance, this.now().toISOString(), id, userId)
      .run();
    return result.meta.changes > 0;
  }

  async deleteMemory(userId: string, id: string): Promise<boolean> {
    const previous = await this.getRecord(userId, id);
    if (!previous) return false;

    await this.deleteRecord(userId, id);
    try {
      await this.options.vectors.deleteMemory(id);
    } catch (error) {
      await this.compensate(
        () => this.insertRecord(toAdminMemory(previous)),
        "delete_memory_compensation_failed",
        id,
      );
      throw error;
    }
    return true;
  }

  private async getRecord(
    userId: string,
    id: string,
  ): Promise<MemoryRow | null> {
    return this.options.database
      .prepare(
        `SELECT id, user_id, text, created_at, updated_at, relevance
         FROM memories WHERE id = ? AND user_id = ?`,
      )
      .bind(id, userId)
      .first<MemoryRow>();
  }

  private async getRecords(
    userId: string,
    ids: string[],
  ): Promise<MemoryRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const result = await this.options.database
      .prepare(
        `SELECT id, user_id, text, created_at, updated_at, relevance
         FROM memories WHERE user_id = ? AND id IN (${placeholders})`,
      )
      .bind(userId, ...ids)
      .all<MemoryRow>();
    return result.results;
  }

  private async insertRecord(memory: AdminMemory): Promise<void> {
    await this.options.database
      .prepare(
        `INSERT INTO memories
         (id, user_id, text, created_at, updated_at, relevance)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        memory.id,
        memory.userId,
        memory.text,
        memory.createdAt,
        memory.updatedAt,
        memory.relevance,
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

function validateRelevance(relevance: number | null) {
  if (
    relevance !== null &&
    (!Number.isInteger(relevance) || relevance < 0 || relevance > 100)
  ) {
    throw new RangeError("Relevance must be an integer from 0 through 100");
  }
}

function normalizePage(page: number) {
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function toEpochDay(date: Date) {
  return Math.floor(date.getTime() / MILLISECONDS_PER_DAY);
}

function toAdminMemory(row: MemoryRow): AdminMemory {
  return {
    id: row.id,
    userId: row.user_id,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    relevance: row.relevance,
  };
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
