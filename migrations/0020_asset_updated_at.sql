-- Preserve capture timestamps; expose a separate business-update timestamp.
ALTER TABLE assets ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE assets SET updated_at=created_at;
CREATE TRIGGER asset_updated_insert AFTER INSERT ON assets
BEGIN UPDATE assets SET updated_at=NEW.created_at WHERE id=NEW.id; END;
CREATE TRIGGER asset_updated_business AFTER UPDATE OF width,height,favorite,filename,file_created_at,file_modified_at,metadata ON assets
WHEN NEW.width<>OLD.width OR NEW.height<>OLD.height OR NEW.favorite<>OLD.favorite
 OR NEW.filename<>OLD.filename OR NEW.file_created_at<>OLD.file_created_at
 OR NEW.file_modified_at<>OLD.file_modified_at OR NEW.metadata<>OLD.metadata
BEGIN UPDATE assets SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END;
