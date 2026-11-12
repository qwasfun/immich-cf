CREATE TABLE web_gps_jobs(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 scope TEXT NOT NULL,source_name TEXT NOT NULL,version TEXT NOT NULL,total INTEGER NOT NULL CHECK(total BETWEEN 0 AND 10000),
 state TEXT NOT NULL CHECK(state IN('running','paused','complete','cancelled')),
 pending INTEGER NOT NULL,succeeded INTEGER NOT NULL DEFAULT 0,located INTEGER NOT NULL DEFAULT 0,
 no_gps INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,
 lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,current_asset_id TEXT,last_asset_id TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 CHECK(total=pending+succeeded+failed+skipped AND pending>=0 AND succeeded>=0 AND located>=0 AND no_gps>=0 AND failed>=0 AND skipped>=0 AND succeeded=located+no_gps)
);
CREATE TABLE web_gps_items(
 job_id TEXT NOT NULL REFERENCES web_gps_jobs(id) ON DELETE CASCADE,seq INTEGER NOT NULL,
 asset_id TEXT NOT NULL,filename TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','done','failed','skipped')),
 outcome TEXT CHECK(outcome IS NULL OR outcome IN('gps','noGps')),
 code TEXT,message TEXT,tries INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,asset_id),UNIQUE(job_id,seq)
);
CREATE INDEX web_gps_items_work ON web_gps_items(job_id,state,seq);
CREATE TRIGGER web_gps_item_counts AFTER UPDATE OF state,outcome ON web_gps_items
WHEN NEW.state<>OLD.state OR NEW.outcome IS NOT OLD.outcome BEGIN
 UPDATE web_gps_jobs SET pending=pending+(NEW.state='pending')-(OLD.state='pending'),
 succeeded=succeeded+(NEW.state='done')-(OLD.state='done'),
 located=located+(NEW.state='done' AND NEW.outcome IS 'gps')-(OLD.state='done' AND OLD.outcome IS 'gps'),
 no_gps=no_gps+(NEW.state='done' AND NEW.outcome IS 'noGps')-(OLD.state='done' AND OLD.outcome IS 'noGps'),
 failed=failed+(NEW.state='failed')-(OLD.state='failed'),skipped=skipped+(NEW.state='skipped')-(OLD.state='skipped')
 WHERE id=NEW.job_id;
END;
CREATE TABLE web_gps_guards(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,job_id TEXT NOT NULL,
 action TEXT NOT NULL,lease TEXT,version TEXT,now_ms INTEGER NOT NULL
);
CREATE TRIGGER web_gps_authorize BEFORE INSERT ON web_gps_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_id AND u.disabled=0 AND s.expires_at>MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN RAISE(ABORT,'GPS_SESSION') END;
 SELECT CASE WHEN NEW.action='create' AND NEW.version<>(COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=NEW.owner_id),0)||':'||COALESCE((SELECT revision FROM album_owner_revisions WHERE owner_id=NEW.owner_id),0)) THEN RAISE(ABORT,'GPS_VERSION') END;
 SELECT CASE WHEN NEW.action='create' AND EXISTS(SELECT 1 FROM web_gps_jobs WHERE owner_id=NEW.owner_id AND state IN('running','paused')) THEN RAISE(ABORT,'GPS_ACTIVE') END;
 SELECT CASE WHEN NEW.action<>'create' AND NOT EXISTS(SELECT 1 FROM web_gps_jobs WHERE id=NEW.job_id AND owner_id=NEW.owner_id) THEN RAISE(ABORT,'GPS_JOB') END;
 SELECT CASE WHEN NEW.action='lease' AND NOT EXISTS(SELECT 1 FROM web_gps_jobs WHERE id=NEW.job_id AND state='running' AND lease_until<=MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN RAISE(ABORT,'GPS_BUSY') END;
 SELECT CASE WHEN NEW.action='finish' AND NOT EXISTS(SELECT 1 FROM web_gps_jobs WHERE id=NEW.job_id AND state IN('running','paused') AND lease=NEW.lease AND lease_until>MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN RAISE(ABORT,'GPS_LEASE') END;
 SELECT CASE WHEN NEW.action='retry' AND NOT EXISTS(SELECT 1 FROM web_gps_jobs WHERE id=NEW.job_id AND state IN('paused','complete') AND lease_until<=MAX(NEW.now_ms,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) THEN RAISE(ABORT,'GPS_BUSY') END;
END;
