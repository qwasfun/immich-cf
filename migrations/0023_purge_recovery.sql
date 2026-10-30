-- Account Cron capacity may be exhausted. Persist an owner-scoped activity lease.
CREATE TABLE asset_purge_recovery(owner_id TEXT PRIMARY KEY,next_run_ms INTEGER NOT NULL);
