-- P3: atomic live revisions, deletion delivery, and retained original references.
CREATE TABLE asset_owner_revisions (owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
INSERT INTO asset_owner_revisions SELECT owner_id,MAX(sync_seq) FROM assets GROUP BY owner_id;
CREATE TABLE retired_assets (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, object_key TEXT NOT NULL,
  integrity_source_key TEXT, bytes INTEGER NOT NULL, checksum TEXT NOT NULL,
  r2_sha1_verified INTEGER NOT NULL, deleted_at TEXT NOT NULL
);
CREATE INDEX retired_assets_owner ON retired_assets(owner_id,id);
CREATE TABLE asset_tombstones (
  asset_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
  sync_seq INTEGER NOT NULL UNIQUE, deleted_at TEXT NOT NULL
);
CREATE INDEX asset_tombstones_owner_seq ON asset_tombstones(owner_id,sync_seq);
CREATE INDEX asset_tombstones_owner_age ON asset_tombstones(owner_id,deleted_at,sync_seq);
CREATE TRIGGER asset_id_retired BEFORE INSERT ON assets
WHEN EXISTS (SELECT 1 FROM retired_assets WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'ASSET_ID_RETIRED'); END;
DROP TRIGGER asset_sync_insert;
DROP TRIGGER asset_sync_dimensions;
CREATE TRIGGER asset_sync_insert AFTER INSERT ON assets
BEGIN
  UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
  UPDATE assets SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1) WHERE id=NEW.id;
  INSERT INTO asset_owner_revisions SELECT NEW.owner_id,value FROM asset_sync_clock WHERE id=1
    ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER asset_sync_dimensions AFTER UPDATE OF width,height,favorite,filename,file_created_at,file_modified_at,metadata ON assets
WHEN NEW.width<>OLD.width OR NEW.height<>OLD.height OR NEW.favorite<>OLD.favorite
  OR NEW.filename<>OLD.filename OR NEW.file_created_at<>OLD.file_created_at
  OR NEW.file_modified_at<>OLD.file_modified_at OR NEW.metadata<>OLD.metadata
BEGIN
  UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
  UPDATE assets SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1) WHERE id=NEW.id;
  INSERT INTO asset_owner_revisions SELECT NEW.owner_id,value FROM asset_sync_clock WHERE id=1
    ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER asset_sync_delete AFTER DELETE ON assets
BEGIN
  UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
  INSERT INTO retired_assets VALUES(OLD.id,OLD.owner_id,OLD.object_key,OLD.integrity_source_key,
    OLD.bytes,OLD.checksum,OLD.r2_sha1_verified,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO asset_tombstones SELECT OLD.id,OLD.owner_id,value,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM asset_sync_clock WHERE id=1;
  INSERT INTO asset_owner_revisions SELECT OLD.owner_id,value FROM asset_sync_clock WHERE id=1
    ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE INDEX assets_owner_metadata_seq ON assets(owner_id,sync_seq) WHERE metadata<>'[]';
CREATE TRIGGER asset_identity_immutable BEFORE UPDATE OF id,owner_id ON assets
WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id
BEGIN SELECT RAISE(ABORT,'ASSET_IDENTITY_IMMUTABLE'); END;
