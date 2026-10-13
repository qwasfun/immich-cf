-- Durable retry location: only unfinished uploads occupy this table.
CREATE TABLE upload_intents (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checksum TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, checksum)
);

-- Include reservations so failures cannot bypass the experimental storage cap.
CREATE TRIGGER upload_intents_limit BEFORE INSERT ON upload_intents
WHEN NOT EXISTS (SELECT 1 FROM upload_intents WHERE owner_id = NEW.owner_id AND checksum = NEW.checksum)
AND NOT EXISTS (SELECT 1 FROM assets WHERE owner_id = NEW.owner_id AND checksum = NEW.checksum)
AND ((SELECT COUNT(*) FROM assets WHERE owner_id = NEW.owner_id)
   + (SELECT COUNT(*) FROM upload_intents WHERE owner_id = NEW.owner_id)) >= 20
BEGIN
  SELECT RAISE(ABORT, 'ASSET_LIMIT');
END;
