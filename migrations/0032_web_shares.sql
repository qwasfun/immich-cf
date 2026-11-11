CREATE TABLE web_shares (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 album_id TEXT REFERENCES albums(id) ON DELETE CASCADE,
 asset_ids TEXT,
 token_hash TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 created_ms INTEGER NOT NULL,
 expires_ms INTEGER NOT NULL,
 CHECK((album_id IS NULL) <> (asset_ids IS NULL))
);
CREATE INDEX web_shares_owner_expiry ON web_shares(owner_id,expires_ms);
CREATE INDEX web_shares_album ON web_shares(album_id);
CREATE INDEX web_shares_expiry ON web_shares(expires_ms);
CREATE TRIGGER web_shares_limit BEFORE INSERT ON web_shares
WHEN (SELECT COUNT(*) FROM web_shares WHERE owner_id=NEW.owner_id AND expires_ms>NEW.created_ms)>=100
BEGIN SELECT RAISE(ABORT,'WEB_SHARE_LIMIT'); END;
CREATE TRIGGER web_shares_disable_user AFTER UPDATE OF disabled ON users
WHEN NEW.disabled=1 AND OLD.disabled<>NEW.disabled
BEGIN DELETE FROM web_shares WHERE owner_id=NEW.id; END;
