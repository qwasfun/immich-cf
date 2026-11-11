-- Additive photo information; immutable originals and opaque mobile-app metadata stay separate.
ALTER TABLE assets ADD COLUMN photo_metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(photo_metadata) AND json_type(photo_metadata)='object' AND length(photo_metadata)<=16384);
ALTER TABLE assets ADD COLUMN local_date_time TEXT NOT NULL DEFAULT '';
CREATE TRIGGER asset_photo_details_changed AFTER UPDATE OF photo_metadata,local_date_time ON assets
WHEN NEW.photo_metadata<>OLD.photo_metadata OR NEW.local_date_time<>OLD.local_date_time
BEGIN
 UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 UPDATE assets SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id;
 INSERT INTO asset_owner_revisions SELECT NEW.owner_id,value FROM asset_sync_clock WHERE id=1
 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TABLE web_photo_guards(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,ids TEXT NOT NULL,now_ms INTEGER NOT NULL);
CREATE TRIGGER web_photo_authorize BEFORE INSERT ON web_photo_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_id AND u.disabled=0 AND s.expires_at>MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN RAISE(ABORT,'PHOTO_SESSION') END;
 SELECT CASE WHEN NEW.version<>COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=NEW.owner_id),0) THEN RAISE(ABORT,'PHOTO_VERSION') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM assets WHERE owner_id=NEW.owner_id AND media_type='IMAGE' AND visibility='timeline' AND deleted_at IS NULL AND id IN(SELECT value FROM json_each(NEW.ids)))<>json_array_length(NEW.ids) THEN RAISE(ABORT,'PHOTO_SCOPE') END;
END;
