ALTER TABLE assets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags)='array' AND json_array_length(tags)<=20 AND length(tags)<=8192);
ALTER TABLE assets ADD COLUMN rating INTEGER CHECK(rating IS NULL OR (typeof(rating)='integer' AND rating BETWEEN 1 AND 5));
ALTER TABLE assets ADD COLUMN rating_touched INTEGER NOT NULL DEFAULT 0 CHECK(rating_touched IN (0,1));
CREATE INDEX assets_owner_rating ON assets(owner_id,rating,deleted_at) WHERE media_type='IMAGE' AND visibility='timeline';
CREATE TABLE photo_tag_index(asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,owner_id TEXT NOT NULL,name TEXT NOT NULL,tag_key TEXT NOT NULL,PRIMARY KEY(asset_id,tag_key));
CREATE INDEX photo_tags_owner_key ON photo_tag_index(owner_id,tag_key,asset_id);
CREATE TRIGGER photo_tags_validate BEFORE UPDATE OF tags ON assets WHEN EXISTS(SELECT 1 FROM json_each(NEW.tags) WHERE type<>'text' OR length(value)<1 OR length(value)>32)
BEGIN SELECT RAISE(ABORT,'LABEL_TAGS'); END;
CREATE TRIGGER photo_tags_insert_validate BEFORE INSERT ON assets WHEN EXISTS(SELECT 1 FROM json_each(NEW.tags) WHERE type<>'text' OR length(value)<1 OR length(value)>32)
BEGIN SELECT RAISE(ABORT,'LABEL_TAGS'); END;
CREATE TRIGGER photo_tags_insert AFTER INSERT ON assets BEGIN
 INSERT OR IGNORE INTO photo_tag_index SELECT NEW.id,NEW.owner_id,value,lower(value) FROM json_each(NEW.tags);
END;
CREATE TRIGGER photo_tags_index AFTER UPDATE OF tags ON assets WHEN NEW.tags<>OLD.tags BEGIN
 DELETE FROM photo_tag_index WHERE asset_id=NEW.id;
 INSERT OR IGNORE INTO photo_tag_index SELECT NEW.id,NEW.owner_id,value,lower(value) FROM json_each(NEW.tags);
END;
CREATE TRIGGER photo_labels_changed AFTER UPDATE OF tags,rating ON assets WHEN NEW.tags<>OLD.tags OR NEW.rating IS NOT OLD.rating BEGIN
 UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 UPDATE assets SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),rating_touched=CASE WHEN NEW.rating IS NOT OLD.rating THEN 1 ELSE rating_touched END WHERE id=NEW.id;
 INSERT INTO asset_owner_revisions SELECT NEW.owner_id,value FROM asset_sync_clock WHERE id=1 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TABLE photo_label_guards(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,ids TEXT NOT NULL,version TEXT NOT NULL,now_ms INTEGER NOT NULL);
CREATE TRIGGER photo_labels_authorize BEFORE INSERT ON photo_label_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_id AND u.disabled=0 AND s.expires_at>MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN RAISE(ABORT,'LABEL_SESSION') END;
 SELECT CASE WHEN NEW.version<>COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=NEW.owner_id),0)||':'||COALESCE((SELECT revision FROM album_owner_revisions WHERE owner_id=NEW.owner_id),0) THEN RAISE(ABORT,'LABEL_VERSION') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM assets WHERE owner_id=NEW.owner_id AND media_type='IMAGE' AND visibility='timeline' AND deleted_at IS NULL AND id IN(SELECT value FROM json_each(NEW.ids)))<>json_array_length(NEW.ids) THEN RAISE(ABORT,'LABEL_SCOPE') END;
END;
