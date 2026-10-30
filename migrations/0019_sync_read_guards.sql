-- Preserve legacy epoch/history guards; reject mixed business snapshots atomically.
CREATE TABLE sync_read_guards(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
 asset_revision INTEGER NOT NULL, onboarding_revision INTEGER NOT NULL,
 user_update_id TEXT NOT NULL
);
CREATE TRIGGER sync_business_read_guard BEFORE INSERT ON sync_read_guards
WHEN (NEW.asset_revision>=0 AND NEW.asset_revision<>COALESCE((
 SELECT r.revision FROM asset_owner_revisions r JOIN sessions s ON s.user_id=r.owner_id WHERE s.id=NEW.session_id),0))
 OR (NEW.onboarding_revision>=0 AND NEW.onboarding_revision<>COALESCE((
 SELECT o.revision FROM user_onboarding o JOIN sessions s ON s.user_id=o.user_id WHERE s.id=NEW.session_id),0))
 OR (NEW.user_update_id<>'' AND NEW.user_update_id<>COALESCE((
 SELECT u.update_id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=NEW.session_id),''))
BEGIN SELECT RAISE(ABORT,'SYNC_STALE'); END;
