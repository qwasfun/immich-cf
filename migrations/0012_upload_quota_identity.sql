-- A rollout can retain an intent when another in-flight publisher used a different ID.
-- Keep its recovery/object reference, but charge an owner+checksum only once.
DROP TRIGGER upload_intents_limit;
CREATE TRIGGER upload_intents_limit BEFORE INSERT ON upload_intents
WHEN NOT EXISTS (SELECT 1 FROM upload_intents WHERE owner_id = NEW.owner_id AND checksum = NEW.checksum)
AND NOT EXISTS (SELECT 1 FROM assets WHERE owner_id = NEW.owner_id AND checksum = NEW.checksum)
AND ((SELECT COUNT(*) FROM assets WHERE owner_id = NEW.owner_id)
   + (SELECT COUNT(*) FROM upload_intents AS pending
      WHERE pending.owner_id = NEW.owner_id
      AND NOT EXISTS (SELECT 1 FROM assets AS published
        WHERE published.owner_id = pending.owner_id AND published.checksum = pending.checksum))) >= 20
BEGIN
  SELECT RAISE(ABORT, 'ASSET_LIMIT');
END;
