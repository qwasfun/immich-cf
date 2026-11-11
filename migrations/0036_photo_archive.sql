-- Archive is a reversible presentation state; paired originals retain their physical visibility.
ALTER TABLE assets ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
CREATE INDEX assets_owner_archive ON assets(owner_id,archived,deleted_at) WHERE media_type='IMAGE' AND visibility='timeline';
CREATE TRIGGER asset_archive_insert BEFORE INSERT ON assets WHEN NEW.archived=1 AND (NEW.media_type<>'IMAGE' OR NEW.visibility<>'timeline')
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PHOTO'); END;
CREATE TRIGGER asset_archive_validate BEFORE UPDATE OF archived ON assets WHEN NEW.archived=1 AND (NEW.media_type<>'IMAGE' OR NEW.visibility<>'timeline')
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PHOTO'); END;
CREATE TRIGGER asset_archive_changed AFTER UPDATE OF archived ON assets WHEN NEW.archived<>OLD.archived BEGIN
 UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 UPDATE assets SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id;
 INSERT INTO asset_owner_revisions SELECT NEW.owner_id,value FROM asset_sync_clock WHERE id=1
 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TABLE photo_archive_guards(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,ids TEXT NOT NULL,version TEXT NOT NULL,now_ms INTEGER NOT NULL);
CREATE TRIGGER photo_archive_authorize BEFORE INSERT ON photo_archive_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_id AND u.disabled=0 AND s.expires_at>MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN RAISE(ABORT,'ARCHIVE_SESSION') END;
 SELECT CASE WHEN NEW.version<>'' AND NEW.version<>COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=NEW.owner_id),0)||':'||COALESCE((SELECT revision FROM album_owner_revisions WHERE owner_id=NEW.owner_id),0) THEN RAISE(ABORT,'ARCHIVE_VERSION') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM assets WHERE owner_id=NEW.owner_id AND media_type='IMAGE' AND visibility='timeline' AND deleted_at IS NULL AND id IN(SELECT value FROM json_each(NEW.ids)))<>json_array_length(NEW.ids) THEN RAISE(ABORT,'ARCHIVE_SCOPE') END;
END;
