-- Retention advances only a deletion floor. Original/source references remain retained.
CREATE TABLE asset_history_floor(owner_id TEXT PRIMARY KEY,min_seq INTEGER NOT NULL);
CREATE TABLE history_cleanup_jobs(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,cutoff TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done'))
);
CREATE INDEX history_cleanup_owner ON history_cleanup_jobs(owner_id,id);
ALTER TABLE sessions ADD COLUMN asset_history_floor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN metadata_history_floor INTEGER NOT NULL DEFAULT 0;
-- Preserve the legacy six-column guard table for in-flight older Workers.
CREATE TABLE sync_history_guards(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,history_floor INTEGER NOT NULL);
CREATE TRIGGER sync_history_floor_guard BEFORE INSERT ON sync_history_guards
WHEN NEW.history_floor<>COALESCE((SELECT f.min_seq FROM asset_history_floor f JOIN sessions s ON s.user_id=f.owner_id WHERE s.id=NEW.session_id),0)
BEGIN SELECT RAISE(ABORT,'SYNC_STALE'); END;
