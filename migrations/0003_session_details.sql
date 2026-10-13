-- Existing sessions have a known 7-day lifetime; recover their creation time.
ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET created_at = expires_at - 604800000, updated_at = expires_at - 604800000;
