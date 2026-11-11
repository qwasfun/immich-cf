-- Only relationship changes. Originals, paired media and album Sync triggers remain authoritative.
CREATE TABLE web_album_transfer_guards(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,
 source_id TEXT NOT NULL,target_id TEXT NOT NULL,ids TEXT NOT NULL,version TEXT NOT NULL,now_ms INTEGER NOT NULL
);
CREATE TRIGGER web_album_transfer_authorize BEFORE INSERT ON web_album_transfer_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_id AND u.disabled=0 AND s.expires_at>MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN RAISE(ABORT,'TRANSFER_SESSION') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM albums WHERE id=NEW.target_id AND owner_id=NEW.owner_id) THEN RAISE(ABORT,'TRANSFER_TARGET') END;
 SELECT CASE WHEN NEW.source_id<>'' AND NOT EXISTS(SELECT 1 FROM albums WHERE id=NEW.source_id AND owner_id=NEW.owner_id) THEN RAISE(ABORT,'TRANSFER_SOURCE') END;
 SELECT CASE WHEN NEW.version<>COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=NEW.owner_id),0)||':'||COALESCE((SELECT revision FROM album_owner_revisions WHERE owner_id=NEW.owner_id),0) THEN RAISE(ABORT,'TRANSFER_VERSION') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM assets a WHERE a.owner_id=NEW.owner_id AND a.media_type='IMAGE' AND a.visibility='timeline' AND a.deleted_at IS NULL AND a.id IN(SELECT value FROM json_each(NEW.ids)) AND (NEW.source_id='' OR EXISTS(SELECT 1 FROM album_assets l WHERE l.album_id=NEW.source_id AND l.asset_id=a.id AND l.owner_id=NEW.owner_id)))<>json_array_length(NEW.ids) THEN RAISE(ABORT,'TRANSFER_PHOTOS') END;
END;
