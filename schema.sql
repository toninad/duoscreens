-- D1 schema for Duo Screenshot Studio. Run once in the Cloudflare dashboard (D1 > your database > Console)
-- or with: npx wrangler d1 execute duo-studio --remote --file=schema.sql
-- License keys are stored only as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS licenses (
  key_hash   TEXT PRIMARY KEY,
  status     TEXT NOT NULL,          -- Polar status: granted / revoked / disabled
  checked_at INTEGER NOT NULL        -- ms since epoch; re-checked with Polar after a day
);

CREATE TABLE IF NOT EXISTS activations (
  key_hash      TEXT NOT NULL,
  device        TEXT NOT NULL,       -- random id the browser generates once
  activation_id TEXT NOT NULL,       -- Polar activation id
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (key_hash, device)
);

CREATE TABLE IF NOT EXISTS translation_usage (
  key_hash TEXT NOT NULL,
  month    TEXT NOT NULL,            -- YYYY-MM
  runs     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_hash, month)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,       -- route:ip:minute
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
