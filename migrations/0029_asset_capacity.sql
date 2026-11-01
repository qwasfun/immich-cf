-- Expand only logical capacity; preserve every asset, pairing, reservation and cursor.
CREATE TABLE asset_quota_config(id INTEGER PRIMARY KEY CHECK(id=1),logical_limit INTEGER NOT NULL CHECK(logical_limit BETWEEN 1 AND 10000));
INSERT INTO asset_quota_config VALUES(1,10000);
CREATE TRIGGER asset_quota_config_keep BEFORE DELETE ON asset_quota_config BEGIN SELECT RAISE(ABORT,'ASSET_QUOTA_CONFIG_REQUIRED'); END;
CREATE TABLE asset_slot_references(owner_id TEXT NOT NULL,slot TEXT NOT NULL,refs INTEGER NOT NULL CHECK(refs>0),PRIMARY KEY(owner_id,slot)) WITHOUT ROWID;
CREATE TABLE asset_owner_usage(owner_id TEXT PRIMARY KEY,logical_assets INTEGER NOT NULL CHECK(logical_assets>=0));
INSERT INTO asset_slot_references
 SELECT owner_id,slot,COUNT(*) FROM (
 SELECT owner_id,COALESCE(NULLIF(logical_key,''),'sha1:'||checksum) slot FROM assets
 UNION ALL SELECT owner_id,COALESCE(NULLIF(logical_key,''),'sha1:'||checksum) slot FROM upload_intents
 ) GROUP BY owner_id,slot;
INSERT INTO asset_owner_usage SELECT owner_id,COUNT(*) FROM asset_slot_references GROUP BY owner_id;
DROP TRIGGER assets_limit;
DROP TRIGGER upload_intents_limit;
DROP VIEW logical_asset_slots;
CREATE VIEW logical_asset_slots AS SELECT owner_id,slot FROM asset_slot_references;

CREATE TRIGGER assets_limit BEFORE INSERT ON assets
 WHEN NOT EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum))
 AND COALESCE((SELECT logical_assets FROM asset_owner_usage WHERE owner_id=NEW.owner_id),0)>=(SELECT logical_limit FROM asset_quota_config WHERE id=1)
 BEGIN SELECT RAISE(ABORT,'ASSET_LIMIT'); END;
CREATE TRIGGER assets_quota_insert AFTER INSERT ON assets BEGIN
 INSERT INTO asset_owner_usage(owner_id,logical_assets) VALUES(NEW.owner_id,1)
 ON CONFLICT(owner_id) DO UPDATE SET logical_assets=logical_assets+CASE WHEN NOT EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum)) THEN 1 ELSE 0 END;
 INSERT INTO asset_slot_references VALUES(NEW.owner_id,COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum),1) ON CONFLICT(owner_id,slot) DO UPDATE SET refs=refs+1;
END;
CREATE TRIGGER assets_quota_delete AFTER DELETE ON assets BEGIN
 DELETE FROM asset_slot_references WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum) AND refs=1;
 UPDATE asset_owner_usage SET logical_assets=logical_assets-changes() WHERE owner_id=OLD.owner_id;
 UPDATE asset_slot_references SET refs=refs-1 WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum);
END;
CREATE TRIGGER assets_quota_update_limit BEFORE UPDATE OF owner_id,checksum,logical_key ON assets
 WHEN (NEW.owner_id<>OLD.owner_id OR COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum)<>COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum)) AND NOT EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum))
 AND COALESCE((SELECT logical_assets FROM asset_owner_usage WHERE owner_id=NEW.owner_id),0)
 -CASE WHEN NEW.owner_id=OLD.owner_id AND EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum) AND refs=1) THEN 1 ELSE 0 END
 >=(SELECT logical_limit FROM asset_quota_config WHERE id=1)
 BEGIN SELECT RAISE(ABORT,'ASSET_LIMIT'); END;
CREATE TRIGGER assets_quota_update AFTER UPDATE OF owner_id,checksum,logical_key ON assets
 WHEN NEW.owner_id<>OLD.owner_id OR COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum)<>COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum) BEGIN
 DELETE FROM asset_slot_references WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum) AND refs=1;
 UPDATE asset_owner_usage SET logical_assets=logical_assets-changes() WHERE owner_id=OLD.owner_id;
 UPDATE asset_slot_references SET refs=refs-1 WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum);
 INSERT INTO asset_owner_usage(owner_id,logical_assets) VALUES(NEW.owner_id,1)
 ON CONFLICT(owner_id) DO UPDATE SET logical_assets=logical_assets+CASE WHEN NOT EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum)) THEN 1 ELSE 0 END;
 INSERT INTO asset_slot_references VALUES(NEW.owner_id,COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum),1) ON CONFLICT(owner_id,slot) DO UPDATE SET refs=refs+1;
END;

CREATE TRIGGER upload_intents_limit BEFORE INSERT ON upload_intents
 WHEN NOT EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum))
 AND COALESCE((SELECT logical_assets FROM asset_owner_usage WHERE owner_id=NEW.owner_id),0)>=(SELECT logical_limit FROM asset_quota_config WHERE id=1)
 BEGIN SELECT RAISE(ABORT,'ASSET_LIMIT'); END;
CREATE TRIGGER upload_intents_quota_insert AFTER INSERT ON upload_intents BEGIN
 INSERT INTO asset_owner_usage(owner_id,logical_assets) VALUES(NEW.owner_id,1)
 ON CONFLICT(owner_id) DO UPDATE SET logical_assets=logical_assets+CASE WHEN NOT EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum)) THEN 1 ELSE 0 END;
 INSERT INTO asset_slot_references VALUES(NEW.owner_id,COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum),1) ON CONFLICT(owner_id,slot) DO UPDATE SET refs=refs+1;
END;
CREATE TRIGGER upload_intents_quota_delete AFTER DELETE ON upload_intents BEGIN
 DELETE FROM asset_slot_references WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum) AND refs=1;
 UPDATE asset_owner_usage SET logical_assets=logical_assets-changes() WHERE owner_id=OLD.owner_id;
 UPDATE asset_slot_references SET refs=refs-1 WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum);
END;
CREATE TRIGGER upload_intents_quota_update_limit BEFORE UPDATE OF owner_id,checksum,logical_key ON upload_intents
 WHEN (NEW.owner_id<>OLD.owner_id OR COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum)<>COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum)) AND NOT EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum))
 AND COALESCE((SELECT logical_assets FROM asset_owner_usage WHERE owner_id=NEW.owner_id),0)
 -CASE WHEN NEW.owner_id=OLD.owner_id AND EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum) AND refs=1) THEN 1 ELSE 0 END
 >=(SELECT logical_limit FROM asset_quota_config WHERE id=1)
 BEGIN SELECT RAISE(ABORT,'ASSET_LIMIT'); END;
CREATE TRIGGER upload_intents_quota_update AFTER UPDATE OF owner_id,checksum,logical_key ON upload_intents
 WHEN NEW.owner_id<>OLD.owner_id OR COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum)<>COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum) BEGIN
 DELETE FROM asset_slot_references WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum) AND refs=1;
 UPDATE asset_owner_usage SET logical_assets=logical_assets-changes() WHERE owner_id=OLD.owner_id;
 UPDATE asset_slot_references SET refs=refs-1 WHERE owner_id=OLD.owner_id AND slot=COALESCE(NULLIF(OLD.logical_key,''),'sha1:'||OLD.checksum);
 INSERT INTO asset_owner_usage(owner_id,logical_assets) VALUES(NEW.owner_id,1)
 ON CONFLICT(owner_id) DO UPDATE SET logical_assets=logical_assets+CASE WHEN NOT EXISTS(SELECT 1 FROM asset_slot_references WHERE owner_id=NEW.owner_id AND slot=COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum)) THEN 1 ELSE 0 END;
 INSERT INTO asset_slot_references VALUES(NEW.owner_id,COALESCE(NULLIF(NEW.logical_key,''),'sha1:'||NEW.checksum),1) ON CONFLICT(owner_id,slot) DO UPDATE SET refs=refs+1;
END;

CREATE INDEX assets_owner_id ON assets(owner_id,id);
CREATE INDEX albums_owner_id ON albums(owner_id,id);
CREATE INDEX album_assets_owner_ids ON album_assets(owner_id,album_id,asset_id);

