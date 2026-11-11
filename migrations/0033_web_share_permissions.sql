ALTER TABLE web_shares ADD COLUMN password_hash TEXT;
ALTER TABLE web_shares ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 0 CHECK(allow_download IN (0,1));

CREATE TABLE web_share_access (
 token_hash TEXT PRIMARY KEY,
 share_id TEXT NOT NULL REFERENCES web_shares(id) ON DELETE CASCADE,
 expires_ms INTEGER NOT NULL
);
CREATE INDEX web_share_access_share ON web_share_access(share_id);
CREATE INDEX web_share_access_expiry ON web_share_access(expires_ms);

CREATE TABLE web_share_unlock_limits (
 share_id TEXT PRIMARY KEY REFERENCES web_shares(id) ON DELETE CASCADE,
 attempts INTEGER NOT NULL,
 reset_ms INTEGER NOT NULL
);

CREATE TRIGGER web_share_password_changed AFTER UPDATE OF password_hash ON web_shares
WHEN NEW.password_hash IS NOT OLD.password_hash
BEGIN
 DELETE FROM web_share_access WHERE share_id=NEW.id;
 DELETE FROM web_share_unlock_limits WHERE share_id=NEW.id;
END;
