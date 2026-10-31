-- Keep existing originals, reservations, cursors and historical rejection evidence.
ALTER TABLE assets ADD COLUMN media_type TEXT NOT NULL DEFAULT 'IMAGE' CHECK(media_type IN ('IMAGE','VIDEO'));
ALTER TABLE assets ADD COLUMN visibility TEXT NOT NULL DEFAULT 'timeline' CHECK(visibility IN ('timeline','hidden'));
ALTER TABLE assets ADD COLUMN duration TEXT;
ALTER TABLE assets ADD COLUMN pair_id TEXT;
ALTER TABLE assets ADD COLUMN live_photo_video_id TEXT;
ALTER TABLE assets ADD COLUMN logical_key TEXT NOT NULL DEFAULT '';
ALTER TABLE upload_intents ADD COLUMN logical_key TEXT NOT NULL DEFAULT '';
ALTER TABLE upload_intents ADD COLUMN media_role TEXT CHECK(media_role IN ('IMAGE','VIDEO'));
CREATE UNIQUE INDEX live_photo_pending_component ON upload_intents(owner_id,logical_key,media_role) WHERE logical_key LIKE 'live:%' AND media_role IS NOT NULL;
CREATE TRIGGER live_photo_intent_match BEFORE INSERT ON upload_intents
WHEN NEW.logical_key LIKE 'live:%' AND EXISTS(SELECT 1 FROM assets WHERE owner_id=NEW.owner_id AND logical_key=NEW.logical_key AND media_type=NEW.media_role AND checksum<>NEW.checksum)
BEGIN SELECT RAISE(ABORT,'LIVE_PHOTO_PAIR'); END;
CREATE UNIQUE INDEX live_photo_one_still ON assets(live_photo_video_id) WHERE live_photo_video_id IS NOT NULL;
CREATE UNIQUE INDEX live_photo_one_component ON assets(owner_id,pair_id,media_type) WHERE pair_id IS NOT NULL;
CREATE INDEX live_photo_owner ON assets(owner_id,visibility,live_photo_video_id);
CREATE TRIGGER live_photo_link_insert BEFORE INSERT ON assets WHEN NEW.live_photo_video_id IS NOT NULL
BEGIN
 SELECT CASE WHEN NEW.media_type<>'IMAGE' OR NEW.visibility<>'timeline' OR NEW.pair_id IS NULL OR NOT EXISTS(
 SELECT 1 FROM assets v WHERE v.id=NEW.live_photo_video_id AND v.owner_id=NEW.owner_id AND v.media_type='VIDEO' AND v.visibility='hidden' AND v.pair_id=NEW.pair_id AND v.deleted_at IS NULL AND v.logical_key=NEW.logical_key)
 THEN RAISE(ABORT,'LIVE_PHOTO_PAIR') END;
END;
CREATE TRIGGER live_photo_link_update BEFORE UPDATE OF live_photo_video_id,pair_id,logical_key,media_type,visibility ON assets
WHEN NEW.live_photo_video_id IS NOT OLD.live_photo_video_id OR NEW.pair_id IS NOT OLD.pair_id OR NEW.logical_key<>OLD.logical_key OR NEW.media_type<>OLD.media_type OR NEW.visibility<>OLD.visibility
BEGIN SELECT RAISE(ABORT,'LIVE_PHOTO_IMMUTABLE'); END;
DROP TRIGGER assets_limit;
DROP TRIGGER upload_intents_limit;
CREATE VIEW logical_asset_slots AS
 SELECT owner_id,COALESCE(NULLIF(logical_key,''),'sha1:'||checksum) slot FROM assets
 UNION SELECT owner_id,COALESCE(NULLIF(logical_key,''),'sha1:'||checksum) slot FROM upload_intents;
CREATE TRIGGER assets_limit BEFORE INSERT ON assets
WHEN NOT EXISTS(SELECT 1 FROM logical_asset_slots WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum))
 AND (SELECT COUNT(*) FROM logical_asset_slots WHERE owner_id=NEW.owner_id)>=20
BEGIN SELECT RAISE(ABORT,'ASSET_LIMIT'); END;
CREATE TRIGGER upload_intents_limit BEFORE INSERT ON upload_intents
WHEN NOT EXISTS(SELECT 1 FROM logical_asset_slots WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum))
 AND (SELECT COUNT(*) FROM logical_asset_slots WHERE owner_id=NEW.owner_id)>=20
BEGIN SELECT RAISE(ABORT,'ASSET_LIMIT'); END;
CREATE TABLE media_upload_staging(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,object_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving','ready','complete','deleting','deleted')),
 expires_ms INTEGER NOT NULL,bytes INTEGER,checksum TEXT
);
CREATE INDEX media_staging_expiry ON media_upload_staging(status,expires_ms);
CREATE TABLE media_previews(
 asset_id TEXT NOT NULL,owner_id TEXT NOT NULL,variant INTEGER NOT NULL CHECK(variant IN (256,2048)),
 object_key TEXT NOT NULL UNIQUE,source_checksum TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','quota','failed','retired')),
 lease_id TEXT,lease_until_ms INTEGER NOT NULL DEFAULT 0,next_try_ms INTEGER NOT NULL DEFAULT 0,
 bytes INTEGER,checksum TEXT,last_error TEXT,PRIMARY KEY(asset_id,variant)
);
CREATE INDEX media_preview_due ON media_previews(status,next_try_ms,lease_until_ms);
CREATE TABLE image_transform_usage(month TEXT NOT NULL,transform_key TEXT NOT NULL,PRIMARY KEY(month,transform_key));
CREATE TABLE image_transform_budget(month TEXT PRIMARY KEY,blocked_until_ms INTEGER NOT NULL);
-- A new hidden video cannot be an album item or cover, including through direct SQL.
CREATE TRIGGER album_live_photo_item BEFORE INSERT ON album_assets
WHEN EXISTS(SELECT 1 FROM assets WHERE id=NEW.asset_id AND visibility='hidden')
BEGIN SELECT RAISE(ABORT,'ALBUM_ASSET_PERMISSION'); END;
CREATE TRIGGER album_live_photo_cover BEFORE UPDATE OF thumbnail_asset_id ON albums
WHEN EXISTS(SELECT 1 FROM assets WHERE id=NEW.thumbnail_asset_id AND visibility='hidden')
BEGIN SELECT RAISE(ABORT,'ALBUM_COVER'); END;
