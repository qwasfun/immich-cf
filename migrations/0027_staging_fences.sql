-- The temporary prefix cannot become an original/reference while cleanup holds a claim.
CREATE TRIGGER staging_claim BEFORE UPDATE OF status ON media_upload_staging WHEN NEW.status='deleting'
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM assets WHERE object_key=NEW.object_key OR integrity_source_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM retired_assets WHERE object_key=NEW.object_key OR integrity_source_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM upload_intents WHERE object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM integrity_copy_intents WHERE object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM media_previews WHERE object_key=NEW.object_key)
 THEN RAISE(ABORT,'STAGING_REFERENCED') END;
END;
CREATE TRIGGER staging_identity BEFORE UPDATE OF id,owner_id,object_key ON media_upload_staging
BEGIN SELECT RAISE(ABORT,'STAGING_IMMUTABLE'); END;
CREATE TRIGGER staging_keep BEFORE DELETE ON media_upload_staging
BEGIN SELECT RAISE(ABORT,'STAGING_IMMUTABLE'); END;
CREATE TRIGGER staging_assets_insert BEFORE INSERT ON assets WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key IN(NEW.object_key,NEW.integrity_source_key)) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
CREATE TRIGGER staging_assets_update BEFORE UPDATE ON assets WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key IN(NEW.object_key,NEW.integrity_source_key)) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
CREATE TRIGGER staging_retired_insert BEFORE INSERT ON retired_assets WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key IN(NEW.object_key,NEW.integrity_source_key)) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
CREATE TRIGGER staging_retired_update BEFORE UPDATE ON retired_assets WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key IN(NEW.object_key,NEW.integrity_source_key)) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
CREATE TRIGGER staging_intents_insert BEFORE INSERT ON upload_intents WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
CREATE TRIGGER staging_intents_update BEFORE UPDATE ON upload_intents WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
CREATE TRIGGER staging_copies_insert BEFORE INSERT ON integrity_copy_intents WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
CREATE TRIGGER staging_copies_update BEFORE UPDATE ON integrity_copy_intents WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
CREATE TRIGGER staging_previews_insert BEFORE INSERT ON media_previews WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
CREATE TRIGGER staging_previews_update BEFORE UPDATE ON media_previews WHEN EXISTS(SELECT 1 FROM media_upload_staging WHERE status IN ('deleting','deleted') AND object_key=NEW.object_key) BEGIN SELECT RAISE(ABORT,'STAGING_FENCED'); END;
