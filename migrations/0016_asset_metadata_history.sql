-- Relationship history for the currently supported asset metadata keys.
CREATE TABLE asset_metadata_tombstones(
 sync_seq INTEGER PRIMARY KEY,owner_id TEXT NOT NULL,asset_id TEXT NOT NULL,
 metadata_key TEXT NOT NULL,deleted_at TEXT NOT NULL
);
CREATE INDEX asset_metadata_tombstones_owner_seq ON asset_metadata_tombstones(owner_id,sync_seq);
CREATE TRIGGER asset_metadata_removed AFTER UPDATE OF metadata ON assets
WHEN NEW.metadata<>OLD.metadata
BEGIN
 INSERT INTO asset_metadata_tombstones
 SELECT (SELECT value FROM asset_sync_clock WHERE id=1)+ROW_NUMBER() OVER(ORDER BY json_extract(removed.value,'$.key')),
 OLD.owner_id,OLD.id,json_extract(removed.value,'$.key'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM json_each(OLD.metadata) removed WHERE NOT EXISTS
 (SELECT 1 FROM json_each(NEW.metadata) current WHERE json_extract(current.value,'$.key')=json_extract(removed.value,'$.key'));
 UPDATE asset_sync_clock SET value=value+changes() WHERE id=1;
END;
