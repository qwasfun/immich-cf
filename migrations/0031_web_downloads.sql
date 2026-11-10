-- Ephemeral download manifests only; existing originals and library rows are unchanged.
CREATE TABLE web_download_jobs(
 id TEXT PRIMARY KEY,
 plan_id TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 filename TEXT NOT NULL,
 entries TEXT NOT NULL CHECK(json_valid(entries) AND json_type(entries)='array'),
 revision TEXT NOT NULL,
 photo_count INTEGER NOT NULL,
 file_count INTEGER NOT NULL,
 total_bytes INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','complete','failed','cancelled')),
 completed_files INTEGER NOT NULL DEFAULT 0,
 completed_bytes INTEGER NOT NULL DEFAULT 0,
 error TEXT NOT NULL DEFAULT '',
 run_id TEXT,
 created_ms INTEGER NOT NULL,
 updated_ms INTEGER NOT NULL,
 expires_ms INTEGER NOT NULL
);
CREATE INDEX web_download_owner ON web_download_jobs(owner_id,expires_ms);
CREATE INDEX web_download_session ON web_download_jobs(session_id);
CREATE INDEX web_download_expiry ON web_download_jobs(expires_ms);
CREATE INDEX web_download_plan ON web_download_jobs(plan_id,owner_id);
CREATE TRIGGER web_download_limit BEFORE INSERT ON web_download_jobs
WHEN (SELECT COUNT(*) FROM web_download_jobs WHERE owner_id=NEW.owner_id AND expires_ms>NEW.created_ms)>=2000
BEGIN SELECT RAISE(ABORT,'DOWNLOAD_QUEUE_LIMIT'); END;
