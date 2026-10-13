CREATE TABLE assets (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checksum TEXT NOT NULL,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  file_created_at TEXT NOT NULL,
  file_modified_at TEXT NOT NULL,
  favorite INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '[]',
  UNIQUE(owner_id, checksum)
);
CREATE INDEX assets_owner_seq ON assets(owner_id, seq);
CREATE TRIGGER assets_limit BEFORE INSERT ON assets
WHEN (SELECT COUNT(*) FROM assets WHERE owner_id = NEW.owner_id) >= 20
AND NOT EXISTS (SELECT 1 FROM assets WHERE owner_id = NEW.owner_id AND checksum = NEW.checksum)
BEGIN
  SELECT RAISE(ABORT, 'ASSET_LIMIT');
END;
