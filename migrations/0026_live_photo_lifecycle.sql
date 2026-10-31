-- Expand each explicit lifecycle authorization inside the same D1 transaction.
CREATE TRIGGER trash_live_photo_group AFTER INSERT ON trash_write_guards
BEGIN
 UPDATE trash_write_guards SET ids=(SELECT json_group_array(id) FROM (
 SELECT value id FROM json_each(NEW.ids)
 UNION SELECT v.id FROM assets p JOIN assets v ON v.id=p.live_photo_video_id AND v.owner_id=p.owner_id WHERE p.owner_id=NEW.owner_id AND p.id IN(SELECT value FROM json_each(NEW.ids))
 UNION SELECT p.id FROM assets p WHERE p.owner_id=NEW.owner_id AND p.live_photo_video_id IN(SELECT value FROM json_each(NEW.ids)))) WHERE id=NEW.id;
END;
DROP TRIGGER purge_object_authorized;
CREATE TRIGGER purge_object_authorized BEFORE INSERT ON asset_purge_objects
WHEN NOT EXISTS(SELECT 1 FROM asset_purge_jobs j JOIN assets a ON a.id=j.asset_id WHERE j.asset_id=NEW.asset_id AND j.owner_id=NEW.owner_id AND
 (a.object_key=NEW.object_key OR a.integrity_source_key=NEW.object_key OR EXISTS(SELECT 1 FROM integrity_copy_intents i WHERE i.asset_id=a.id AND i.owner_id=a.owner_id AND i.object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM media_previews p WHERE p.asset_id=a.id AND p.owner_id=a.owner_id AND p.object_key=NEW.object_key)))
BEGIN SELECT RAISE(ABORT,'PURGE_UNAUTHORIZED'); END;
CREATE TRIGGER preview_retire AFTER DELETE ON assets
BEGIN UPDATE media_previews SET status='retired' WHERE asset_id=OLD.id AND owner_id=OLD.owner_id; END;
CREATE TRIGGER preview_identity BEFORE UPDATE OF asset_id,owner_id,variant,object_key,source_checksum ON media_previews
BEGIN SELECT RAISE(ABORT,'PREVIEW_IMMUTABLE'); END;
CREATE TRIGGER preview_owner BEFORE INSERT ON media_previews
WHEN NOT EXISTS(SELECT 1 FROM assets WHERE id=NEW.asset_id AND owner_id=NEW.owner_id AND checksum=NEW.source_checksum AND mime='image/heic')
 OR substr(NEW.object_key,1,length(NEW.owner_id)+length(NEW.asset_id)+2)<>NEW.owner_id||'/'||NEW.asset_id||'/'
 OR EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'PREVIEW_PERMISSION'); END;
CREATE TRIGGER preview_purge_fence BEFORE INSERT ON asset_purge_fences
WHEN EXISTS(SELECT 1 FROM media_previews WHERE object_key=NEW.object_key AND (status<>'retired' OR lease_until_ms>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)))
BEGIN SELECT RAISE(ABORT,'PURGE_REFERENCED'); END;
