-- Pro sync. Everything stored here is end-to-end encrypted by the browser: the server keeps
-- ciphertext, sizes and versions, never screenshots or text it can read. Rows are keyed by the
-- SHA-256 of the license key, like the rest of the schema.

CREATE TABLE IF NOT EXISTS sync_boards (
  key_hash   TEXT NOT NULL,
  id         TEXT NOT NULL,             -- random id the browser gave the board
  version    INTEGER NOT NULL,          -- +1 on every accepted write; writes name the version they started from
  deleted    INTEGER NOT NULL DEFAULT 0,-- tombstone, so other browsers learn about deletions (purged after 90 days)
  data       TEXT,                      -- base64 ciphertext of the board; NULL once deleted
  bytes      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,          -- ms since epoch
  PRIMARY KEY (key_hash, id)
);

CREATE TABLE IF NOT EXISTS sync_images (
  key_hash     TEXT NOT NULL,
  id           TEXT NOT NULL,           -- HMAC of the image's content hash (the server can't link it to the image)
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  orphan_since INTEGER,                 -- set by the daily cleanup when no board uses it; deleted 7 days later
  PRIMARY KEY (key_hash, id)
);

CREATE TABLE IF NOT EXISTS sync_refs (
  key_hash TEXT NOT NULL,
  board_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  PRIMARY KEY (key_hash, board_id, image_id)
);
CREATE INDEX IF NOT EXISTS sync_refs_image ON sync_refs (key_hash, image_id);

-- When a key's synced data was deleted ("Delete synced data"), so other browsers stop syncing
-- instead of uploading everything again.
CREATE TABLE IF NOT EXISTS sync_keys (
  key_hash  TEXT PRIMARY KEY,
  wiped_at  INTEGER NOT NULL
);
