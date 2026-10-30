-- Permanent fences: never expire or release after uncertain R2 outcomes.
CREATE TABLE integrity_copy_intents (
  object_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, asset_id TEXT NOT NULL
);
CREATE TABLE r2_cleanup_claims (
  object_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed','done'))
);
CREATE INDEX assets_r2_object_key ON assets(object_key);
CREATE INDEX assets_r2_source_key ON assets(integrity_source_key);
CREATE INDEX retired_r2_object_key ON retired_assets(object_key);
CREATE INDEX retired_r2_source_key ON retired_assets(integrity_source_key);
CREATE TRIGGER r2_cleanup_unreferenced BEFORE INSERT ON r2_cleanup_claims
WHEN EXISTS(SELECT 1 FROM assets WHERE object_key=NEW.object_key OR integrity_source_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM retired_assets WHERE object_key=NEW.object_key OR integrity_source_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM upload_intents WHERE object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM integrity_copy_intents WHERE object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'R2_REFERENCED'); END;
CREATE TRIGGER r2_cleanup_no_delete BEFORE DELETE ON r2_cleanup_claims
BEGIN SELECT RAISE(ABORT,'R2_FENCE_PERMANENT'); END;
CREATE TRIGGER r2_cleanup_identity BEFORE UPDATE OF object_key,owner_id ON r2_cleanup_claims
BEGIN SELECT RAISE(ABORT,'R2_FENCE_PERMANENT'); END;
CREATE TRIGGER assets_r2_fence_insert BEFORE INSERT ON assets
WHEN EXISTS(SELECT 1 FROM r2_cleanup_claims WHERE object_key=NEW.object_key OR object_key=NEW.integrity_source_key)
BEGIN SELECT RAISE(ABORT,'R2_CLEANUP_CLAIMED'); END;
CREATE TRIGGER assets_r2_fence_update BEFORE UPDATE OF object_key,integrity_source_key ON assets
WHEN EXISTS(SELECT 1 FROM r2_cleanup_claims WHERE object_key=NEW.object_key OR object_key=NEW.integrity_source_key)
BEGIN SELECT RAISE(ABORT,'R2_CLEANUP_CLAIMED'); END;
CREATE TRIGGER retired_assets_r2_fence_insert BEFORE INSERT ON retired_assets
WHEN EXISTS(SELECT 1 FROM r2_cleanup_claims WHERE object_key=NEW.object_key OR object_key=NEW.integrity_source_key)
BEGIN SELECT RAISE(ABORT,'R2_CLEANUP_CLAIMED'); END;
CREATE TRIGGER retired_assets_r2_fence_update BEFORE UPDATE OF object_key,integrity_source_key ON retired_assets
WHEN EXISTS(SELECT 1 FROM r2_cleanup_claims WHERE object_key=NEW.object_key OR object_key=NEW.integrity_source_key)
BEGIN SELECT RAISE(ABORT,'R2_CLEANUP_CLAIMED'); END;
CREATE TRIGGER upload_intents_r2_fence_insert BEFORE INSERT ON upload_intents
WHEN EXISTS(SELECT 1 FROM r2_cleanup_claims WHERE object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'R2_CLEANUP_CLAIMED'); END;
CREATE TRIGGER upload_intents_r2_fence_update BEFORE UPDATE OF object_key ON upload_intents
WHEN EXISTS(SELECT 1 FROM r2_cleanup_claims WHERE object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'R2_CLEANUP_CLAIMED'); END;
CREATE TRIGGER integrity_copy_intents_r2_fence_insert BEFORE INSERT ON integrity_copy_intents
WHEN EXISTS(SELECT 1 FROM r2_cleanup_claims WHERE object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'R2_CLEANUP_CLAIMED'); END;
CREATE TRIGGER integrity_copy_intents_r2_fence_update BEFORE UPDATE OF object_key ON integrity_copy_intents
WHEN EXISTS(SELECT 1 FROM r2_cleanup_claims WHERE object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'R2_CLEANUP_CLAIMED'); END;
