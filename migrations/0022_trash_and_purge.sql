-- Trash is a state of a live asset; permanent deletion uses an authorized outbox.
ALTER TABLE assets ADD COLUMN deleted_at TEXT;
CREATE INDEX assets_owner_deleted ON assets(owner_id,deleted_at);
CREATE TABLE trash_write_guards(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,owner_id TEXT NOT NULL,operation TEXT NOT NULL,ids TEXT NOT NULL,now_ms INTEGER NOT NULL);
CREATE TRIGGER trash_write_validate BEFORE INSERT ON trash_write_guards
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_id AND s.expires_at>MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0) THEN RAISE(ABORT,'TRASH_SESSION') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.ids) v WHERE NOT EXISTS(SELECT 1 FROM assets WHERE id=v.value AND owner_id=NEW.owner_id) AND NOT(NEW.operation='purge' AND EXISTS(SELECT 1 FROM asset_purge_jobs WHERE asset_id=v.value AND owner_id=NEW.owner_id))) THEN RAISE(ABORT,'TRASH_ASSET_PERMISSION') END;
END;
CREATE TABLE asset_purge_jobs(asset_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','blocked','done')),next_check_ms INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE INDEX purge_jobs_due ON asset_purge_jobs(next_check_ms,asset_id);
CREATE INDEX purge_jobs_owner ON asset_purge_jobs(owner_id,asset_id);
CREATE TABLE asset_purge_objects(asset_id TEXT NOT NULL,owner_id TEXT NOT NULL,object_key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),checked_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(asset_id,object_key));
CREATE INDEX purge_objects_key ON asset_purge_objects(object_key);
CREATE TABLE asset_purge_fences(object_key TEXT PRIMARY KEY,asset_id TEXT NOT NULL,owner_id TEXT NOT NULL);
CREATE TRIGGER purge_job_authorized BEFORE INSERT ON asset_purge_jobs
WHEN NOT EXISTS(SELECT 1 FROM trash_write_guards g,json_each(g.ids) v WHERE g.owner_id=NEW.owner_id AND g.operation='purge' AND v.value=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'PURGE_UNAUTHORIZED'); END;
CREATE TRIGGER purge_job_immutable BEFORE UPDATE OF asset_id,owner_id,created_at ON asset_purge_jobs
BEGIN SELECT RAISE(ABORT,'PURGE_IMMUTABLE'); END;
CREATE TRIGGER purge_job_keep BEFORE DELETE ON asset_purge_jobs
BEGIN SELECT RAISE(ABORT,'PURGE_IMMUTABLE'); END;
CREATE TRIGGER purge_object_authorized BEFORE INSERT ON asset_purge_objects
WHEN NOT EXISTS(SELECT 1 FROM asset_purge_jobs j JOIN assets a ON a.id=j.asset_id WHERE j.asset_id=NEW.asset_id AND j.owner_id=NEW.owner_id AND
 (a.object_key=NEW.object_key OR a.integrity_source_key=NEW.object_key OR EXISTS(SELECT 1 FROM integrity_copy_intents i WHERE i.asset_id=a.id AND i.owner_id=a.owner_id AND i.object_key=NEW.object_key)))
BEGIN SELECT RAISE(ABORT,'PURGE_UNAUTHORIZED'); END;
CREATE TRIGGER purge_object_immutable BEFORE UPDATE OF asset_id,owner_id,object_key,kind ON asset_purge_objects
BEGIN SELECT RAISE(ABORT,'PURGE_IMMUTABLE'); END;
CREATE TRIGGER purge_object_keep BEFORE DELETE ON asset_purge_objects
BEGIN SELECT RAISE(ABORT,'PURGE_IMMUTABLE'); END;
CREATE TRIGGER purge_fence_validate BEFORE INSERT ON asset_purge_fences
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM asset_purge_jobs j JOIN asset_purge_objects o ON o.asset_id=j.asset_id JOIN retired_assets r ON r.id=j.asset_id AND r.owner_id=j.owner_id WHERE j.asset_id=NEW.asset_id AND j.owner_id=NEW.owner_id AND o.object_key=NEW.object_key)
  OR substr(NEW.object_key,1,length(NEW.owner_id)+1)<>NEW.owner_id||'/' THEN RAISE(ABORT,'PURGE_UNAUTHORIZED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assets WHERE object_key=NEW.object_key OR integrity_source_key=NEW.object_key)
  OR EXISTS(SELECT 1 FROM retired_assets WHERE id<>NEW.asset_id AND (object_key=NEW.object_key OR integrity_source_key=NEW.object_key))
  OR EXISTS(SELECT 1 FROM upload_intents WHERE object_key=NEW.object_key)
  OR EXISTS(SELECT 1 FROM integrity_copy_intents WHERE object_key=NEW.object_key AND (asset_id<>NEW.asset_id OR owner_id<>NEW.owner_id)) THEN RAISE(ABORT,'PURGE_REFERENCED') END;
END;
CREATE TRIGGER purge_fence_keep BEFORE DELETE ON asset_purge_fences
BEGIN SELECT RAISE(ABORT,'PURGE_IMMUTABLE'); END;
CREATE TRIGGER purge_fence_immutable BEFORE UPDATE ON asset_purge_fences
BEGIN SELECT RAISE(ABORT,'PURGE_IMMUTABLE'); END;
CREATE TRIGGER assets_purge_insert BEFORE INSERT ON assets WHEN EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key OR object_key=NEW.integrity_source_key) BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER assets_purge_update BEFORE UPDATE ON assets WHEN EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key OR object_key=NEW.integrity_source_key) BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER retired_assets_purge_insert BEFORE INSERT ON retired_assets WHEN EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key OR object_key=NEW.integrity_source_key) BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER retired_assets_purge_update BEFORE UPDATE ON retired_assets WHEN EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key OR object_key=NEW.integrity_source_key) BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER upload_intents_purge_insert BEFORE INSERT ON upload_intents WHEN EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER upload_intents_purge_update BEFORE UPDATE ON upload_intents WHEN EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER integrity_copy_intents_purge_insert BEFORE INSERT ON integrity_copy_intents WHEN EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER integrity_copy_intents_purge_update BEFORE UPDATE ON integrity_copy_intents WHEN EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER purge_no_new_copy BEFORE INSERT ON integrity_copy_intents
WHEN EXISTS(SELECT 1 FROM asset_purge_jobs WHERE asset_id=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER purge_no_reassigned_copy BEFORE UPDATE OF asset_id,owner_id ON integrity_copy_intents
WHEN EXISTS(SELECT 1 FROM asset_purge_jobs WHERE asset_id=NEW.asset_id OR asset_id=OLD.asset_id)
BEGIN SELECT RAISE(ABORT,'PURGE_FENCED'); END;
CREATE TRIGGER retired_purge_keep BEFORE DELETE ON retired_assets WHEN EXISTS(SELECT 1 FROM asset_purge_jobs WHERE asset_id=OLD.id) BEGIN SELECT RAISE(ABORT,'PURGE_IMMUTABLE'); END;
CREATE TRIGGER copy_purge_keep BEFORE DELETE ON integrity_copy_intents WHEN EXISTS(SELECT 1 FROM asset_purge_jobs WHERE asset_id=OLD.asset_id) BEGIN SELECT RAISE(ABORT,'PURGE_IMMUTABLE'); END;
CREATE TRIGGER asset_trash_update AFTER UPDATE OF deleted_at ON assets WHEN NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
 UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 UPDATE assets SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id;
 INSERT INTO asset_owner_revisions SELECT NEW.owner_id,value FROM asset_sync_clock WHERE id=1 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
 UPDATE albums SET thumbnail_asset_id=CASE WHEN EXISTS(SELECT 1 FROM assets a JOIN album_assets l ON l.asset_id=a.id WHERE l.album_id=albums.id AND a.id=albums.thumbnail_asset_id AND a.deleted_at IS NULL) THEN thumbnail_asset_id ELSE
  (SELECT l.asset_id FROM album_assets l JOIN assets a ON a.id=l.asset_id WHERE l.album_id=albums.id AND a.deleted_at IS NULL ORDER BY a.file_created_at DESC,l.asset_id LIMIT 1) END,touch_revision=touch_revision+1
 WHERE id IN(SELECT album_id FROM album_assets WHERE asset_id=NEW.id);
END;
DROP TRIGGER album_cover_validate;
CREATE TRIGGER album_cover_validate BEFORE UPDATE OF thumbnail_asset_id ON albums
WHEN NEW.thumbnail_asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM album_assets l JOIN assets a ON a.id=l.asset_id WHERE l.album_id=NEW.id AND l.asset_id=NEW.thumbnail_asset_id AND l.owner_id=NEW.owner_id AND a.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'ALBUM_COVER'); END;
DROP TRIGGER album_link_owner;
CREATE TRIGGER album_link_owner BEFORE INSERT ON album_assets
WHEN NOT EXISTS(SELECT 1 FROM albums b JOIN assets a ON a.owner_id=b.owner_id WHERE b.id=NEW.album_id AND a.id=NEW.asset_id AND b.owner_id=NEW.owner_id AND a.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'ALBUM_ASSET_PERMISSION'); END;
DROP TRIGGER album_link_delete;
CREATE TRIGGER album_link_delete AFTER DELETE ON album_assets
BEGIN
 UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 INSERT INTO album_asset_deletions SELECT OLD.album_id,OLD.asset_id,OLD.owner_id,value,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM asset_sync_clock WHERE id=1;
 INSERT INTO album_owner_revisions SELECT OLD.owner_id,value FROM asset_sync_clock WHERE id=1 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
 UPDATE albums SET thumbnail_asset_id=CASE WHEN thumbnail_asset_id=OLD.asset_id THEN
  (SELECT l.asset_id FROM album_assets l JOIN assets a ON a.id=l.asset_id WHERE l.album_id=OLD.album_id AND a.deleted_at IS NULL ORDER BY a.file_created_at DESC,l.asset_id LIMIT 1)
  ELSE thumbnail_asset_id END,touch_revision=touch_revision+1 WHERE id=OLD.album_id;
END;
CREATE TRIGGER album_write_active_assets BEFORE INSERT ON album_write_guards
WHEN (NEW.operation='add' OR (NEW.operation='create' AND NEW.apply=1)) AND EXISTS(SELECT 1 FROM json_each(NEW.ids) v JOIN assets a ON a.id=v.value WHERE a.deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'ALBUM_ASSET_PERMISSION'); END;
