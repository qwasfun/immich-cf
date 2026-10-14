ALTER TABLE assets ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;
UPDATE assets SET sync_seq=seq;
CREATE TABLE asset_sync_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
INSERT INTO asset_sync_clock SELECT 1,COALESCE(MAX(seq),0) FROM assets;
CREATE INDEX assets_owner_sync_seq ON assets(owner_id,sync_seq);
CREATE TRIGGER asset_sync_insert AFTER INSERT ON assets
BEGIN
  UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
  UPDATE assets SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1) WHERE id=NEW.id;
END;
CREATE TRIGGER asset_sync_dimensions AFTER UPDATE OF width,height ON assets
WHEN NEW.width<>OLD.width OR NEW.height<>OLD.height
BEGIN
  UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
  UPDATE assets SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1) WHERE id=NEW.id;
END;
