-- Additive Web V1 indexes and transactional authorization; existing data is untouched.
CREATE INDEX web_photos_date ON assets(owner_id,julianday(file_created_at) DESC,id DESC) WHERE media_type='IMAGE' AND visibility='timeline' AND deleted_at IS NULL;
CREATE INDEX web_favorites_date ON assets(owner_id,favorite,julianday(file_created_at) DESC,id DESC) WHERE media_type='IMAGE' AND visibility='timeline' AND deleted_at IS NULL;
CREATE INDEX web_trash_date ON assets(owner_id,julianday(deleted_at) DESC,id DESC) WHERE media_type='IMAGE' AND visibility='timeline' AND deleted_at IS NOT NULL;
-- Extend the existing derivative ownership fence to all supported still-image formats.
DROP TRIGGER preview_owner;
CREATE TRIGGER preview_owner BEFORE INSERT ON media_previews
WHEN NOT EXISTS(SELECT 1 FROM assets WHERE id=NEW.asset_id AND owner_id=NEW.owner_id AND checksum=NEW.source_checksum AND media_type='IMAGE' AND mime IN ('image/jpeg','image/png','image/heic'))
 OR substr(NEW.object_key,1,length(NEW.owner_id)+length(NEW.asset_id)+2)<>NEW.owner_id||'/'||NEW.asset_id||'/'
 OR EXISTS(SELECT 1 FROM asset_purge_fences WHERE object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT,'PREVIEW_PERMISSION'); END;
CREATE TABLE web_account_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,target_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX web_account_audit_actor ON web_account_audit(actor_id,created_at);
CREATE TABLE web_account_guards(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,session_id TEXT NOT NULL,target_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('create','rename','disable','enable','reset-password','revoke-sessions','change-password')),now_ms INTEGER NOT NULL,verified_hash TEXT);
CREATE TRIGGER web_account_authorize BEFORE INSERT ON web_account_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=NEW.session_id AND s.user_id=NEW.actor_id AND u.disabled=0 AND s.expires_at>MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN RAISE(ABORT,'WEB_SESSION') END;
 SELECT CASE WHEN NEW.action<>'change-password' AND NOT EXISTS(SELECT 1 FROM operations_admins WHERE user_id=NEW.actor_id) THEN RAISE(ABORT,'WEB_ADMIN') END;
 SELECT CASE WHEN NEW.action<>'create' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.target_id) THEN RAISE(ABORT,'WEB_TARGET') END;
 SELECT CASE WHEN NEW.action<>'change-password' AND EXISTS(SELECT 1 FROM operations_admins WHERE user_id=NEW.target_id) THEN RAISE(ABORT,'WEB_OPERATOR_TARGET') END;
 SELECT CASE WHEN NEW.action='change-password' AND (NEW.target_id<>NEW.actor_id OR NEW.verified_hash IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_id AND password_hash=NEW.verified_hash)) THEN RAISE(ABORT,'WEB_PASSWORD_CHANGED') END;
END;
CREATE TRIGGER web_account_record AFTER INSERT ON web_account_guards BEGIN
 INSERT INTO web_account_audit VALUES(NEW.id,NEW.actor_id,NEW.target_id,NEW.action,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
