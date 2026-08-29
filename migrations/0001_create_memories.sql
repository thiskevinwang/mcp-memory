CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  relevance INTEGER CHECK (
    relevance IS NULL OR relevance BETWEEN 0 AND 100
  )
);

CREATE INDEX memories_user_created_at
  ON memories (user_id, created_at DESC, id DESC);

