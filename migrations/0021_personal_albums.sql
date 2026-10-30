-- Personal albums only. All media references remain in assets/retired_assets.
CREATE TABLE albums(
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', thumbnail_asset_id TEXT,
 sort_order TEXT NOT NULL DEFAULT 'desc' CHECK(sort_order IN ('asc','desc')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 sync_seq INTEGER NOT NULL DEFAULT 0,created_seq INTEGER NOT NULL DEFAULT 0,touch_revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX albums_owner_seq ON albums(owner_id,sync_seq);
CREATE INDEX albums_owner_created ON albums(owner_id,created_seq);
CREATE TABLE album_assets(
 album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL,sync_seq INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(album_id,asset_id)
);
CREATE INDEX album_assets_owner_seq ON album_assets(owner_id,sync_seq);
CREATE INDEX album_assets_asset ON album_assets(asset_id,album_id);
CREATE TABLE album_owner_revisions(owner_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
CREATE TABLE album_deletions(album_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,sync_seq INTEGER NOT NULL,deleted_at TEXT NOT NULL);
CREATE INDEX album_deletions_owner_seq ON album_deletions(owner_id,sync_seq);
CREATE TABLE album_asset_deletions(album_id TEXT NOT NULL,asset_id TEXT NOT NULL,owner_id TEXT NOT NULL,sync_seq INTEGER PRIMARY KEY,deleted_at TEXT NOT NULL);
CREATE INDEX album_asset_deletions_owner_seq ON album_asset_deletions(owner_id,sync_seq);
CREATE TABLE album_create_requests(owner_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,album_id TEXT NOT NULL,PRIMARY KEY(owner_id,request_key));
CREATE TABLE album_write_guards(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,owner_id TEXT NOT NULL,album_id TEXT NOT NULL,operation TEXT NOT NULL,ids TEXT NOT NULL,cover TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,now_ms INTEGER NOT NULL,apply INTEGER NOT NULL,existing_ids TEXT NOT NULL);
CREATE TRIGGER album_write_validate BEFORE INSERT ON album_write_guards
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_id AND s.expires_at>MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0) THEN RAISE(ABORT,'ALBUM_SESSION') END;
 SELECT CASE WHEN NEW.request_key<>'' AND EXISTS(SELECT 1 FROM album_create_requests WHERE owner_id=NEW.owner_id AND request_key=NEW.request_key AND request_hash<>NEW.request_hash) THEN RAISE(ABORT,'ALBUM_REQUEST_CONFLICT') END;
 SELECT CASE WHEN NEW.operation='create' AND NEW.apply=0 AND NOT EXISTS(SELECT 1 FROM album_create_requests WHERE owner_id=NEW.owner_id AND request_key=NEW.request_key AND album_id=NEW.album_id AND request_hash=NEW.request_hash) THEN RAISE(ABORT,'ALBUM_NOT_FOUND') END;
 SELECT CASE WHEN NEW.operation<>'create' AND NOT EXISTS(SELECT 1 FROM albums WHERE id=NEW.album_id AND owner_id=NEW.owner_id) AND NOT(NEW.operation='delete' AND EXISTS(SELECT 1 FROM album_deletions WHERE album_id=NEW.album_id AND owner_id=NEW.owner_id)) THEN RAISE(ABORT,'ALBUM_NOT_FOUND') END;
 SELECT CASE WHEN (NEW.operation='add' OR (NEW.operation='create' AND NEW.apply=1)) AND EXISTS(SELECT 1 FROM json_each(NEW.ids) v WHERE NOT EXISTS(SELECT 1 FROM assets WHERE id=v.value AND owner_id=NEW.owner_id)) THEN RAISE(ABORT,'ALBUM_ASSET_PERMISSION') END;
 SELECT CASE WHEN NEW.cover<>'' AND NOT EXISTS(SELECT 1 FROM album_assets l JOIN assets a ON a.id=l.asset_id WHERE l.album_id=NEW.album_id AND l.asset_id=NEW.cover AND a.owner_id=NEW.owner_id) THEN RAISE(ABORT,'ALBUM_COVER') END;
END;
CREATE TABLE sync_album_read_guards(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,revision INTEGER NOT NULL);
CREATE TRIGGER sync_album_read_validate BEFORE INSERT ON sync_album_read_guards
WHEN NEW.revision<>COALESCE((SELECT r.revision FROM album_owner_revisions r JOIN sessions s ON s.user_id=r.owner_id WHERE s.id=NEW.session_id),0)
BEGIN SELECT RAISE(ABORT,'SYNC_STALE'); END;
CREATE TRIGGER album_insert_validate BEFORE INSERT ON albums
BEGIN
 SELECT CASE WHEN NEW.thumbnail_asset_id IS NOT NULL THEN RAISE(ABORT,'ALBUM_COVER') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM album_deletions WHERE album_id=NEW.id) THEN RAISE(ABORT,'ALBUM_RETIRED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM albums WHERE id=NEW.id) AND (SELECT COUNT(*) FROM albums WHERE owner_id=NEW.owner_id)>=100 THEN RAISE(ABORT,'ALBUM_LIMIT') END;
END;
CREATE TRIGGER album_identity_immutable BEFORE UPDATE OF id,owner_id ON albums
WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id
BEGIN SELECT RAISE(ABORT,'ALBUM_IDENTITY'); END;
CREATE TRIGGER album_link_identity BEFORE UPDATE OF album_id,asset_id,owner_id ON album_assets
BEGIN SELECT RAISE(ABORT,'ALBUM_IDENTITY'); END;
CREATE TRIGGER album_link_owner BEFORE INSERT ON album_assets
WHEN NOT EXISTS(SELECT 1 FROM albums b JOIN assets a ON a.owner_id=b.owner_id WHERE b.id=NEW.album_id AND a.id=NEW.asset_id AND b.owner_id=NEW.owner_id)
BEGIN SELECT RAISE(ABORT,'ALBUM_ASSET_PERMISSION'); END;
CREATE TRIGGER album_cover_validate BEFORE UPDATE OF thumbnail_asset_id ON albums
WHEN NEW.thumbnail_asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM album_assets WHERE album_id=NEW.id AND asset_id=NEW.thumbnail_asset_id AND owner_id=NEW.owner_id)
BEGIN SELECT RAISE(ABORT,'ALBUM_COVER'); END;
CREATE TRIGGER album_sync_insert AFTER INSERT ON albums
BEGIN UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 UPDATE albums SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1),created_seq=(SELECT value FROM asset_sync_clock WHERE id=1) WHERE id=NEW.id;
 INSERT INTO album_owner_revisions SELECT NEW.owner_id,value FROM asset_sync_clock WHERE id=1 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision; END;
CREATE TRIGGER album_sync_update AFTER UPDATE OF name,description,thumbnail_asset_id,sort_order,touch_revision ON albums
WHEN NEW.name<>OLD.name OR NEW.description<>OLD.description OR NEW.thumbnail_asset_id IS NOT OLD.thumbnail_asset_id OR NEW.sort_order<>OLD.sort_order OR NEW.touch_revision<>OLD.touch_revision
BEGIN UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 UPDATE albums SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id;
 INSERT INTO album_owner_revisions SELECT NEW.owner_id,value FROM asset_sync_clock WHERE id=1 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision; END;
CREATE TRIGGER album_sync_delete AFTER DELETE ON albums
BEGIN UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 INSERT INTO album_deletions SELECT OLD.id,OLD.owner_id,value,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM asset_sync_clock WHERE id=1;
 INSERT INTO album_owner_revisions SELECT OLD.owner_id,value FROM asset_sync_clock WHERE id=1 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision; END;
CREATE TRIGGER album_link_insert AFTER INSERT ON album_assets
BEGIN UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 UPDATE album_assets SET sync_seq=(SELECT value FROM asset_sync_clock WHERE id=1) WHERE album_id=NEW.album_id AND asset_id=NEW.asset_id;
 INSERT INTO album_owner_revisions SELECT NEW.owner_id,value FROM asset_sync_clock WHERE id=1 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
 UPDATE albums SET thumbnail_asset_id=COALESCE(thumbnail_asset_id,NEW.asset_id),touch_revision=touch_revision+1 WHERE id=NEW.album_id;
END;
CREATE TRIGGER album_link_delete AFTER DELETE ON album_assets
BEGIN UPDATE asset_sync_clock SET value=value+1 WHERE id=1;
 INSERT INTO album_asset_deletions SELECT OLD.album_id,OLD.asset_id,OLD.owner_id,value,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM asset_sync_clock WHERE id=1;
 INSERT INTO album_owner_revisions SELECT OLD.owner_id,value FROM asset_sync_clock WHERE id=1 ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision;
 UPDATE albums SET thumbnail_asset_id=CASE WHEN thumbnail_asset_id=OLD.asset_id THEN
  (SELECT l.asset_id FROM album_assets l JOIN assets a ON a.id=l.asset_id WHERE l.album_id=OLD.album_id ORDER BY a.file_created_at DESC,l.asset_id LIMIT 1)
  ELSE thumbnail_asset_id END,touch_revision=touch_revision+1 WHERE id=OLD.album_id;
END;
