ALTER TABLE sessions ADD COLUMN sync_epoch TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN reset_ack TEXT;
ALTER TABLE sessions ADD COLUMN last_reset_ack TEXT;
UPDATE sessions SET reset_ack = 'SyncResetV1|reset' WHERE reset_pending = 1;

-- Ephemeral guards exist only inside an atomic D1 batch, never between requests.
CREATE TABLE sync_guards (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  operation TEXT NOT NULL,
  acks TEXT NOT NULL,
  now_ms INTEGER NOT NULL
);
CREATE TRIGGER sync_guard_session BEFORE INSERT ON sync_guards
WHEN NOT EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.id=NEW.session_id AND s.sync_epoch=NEW.epoch
  AND s.expires_at>MAX(NEW.now_ms, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
  AND u.disabled=0)
BEGIN
  SELECT RAISE(ABORT, 'SYNC_STALE');
END;
CREATE TRIGGER sync_guard_pending BEFORE INSERT ON sync_guards
WHEN NEW.operation='pending' AND NOT EXISTS
  (SELECT 1 FROM sessions WHERE id=NEW.session_id AND reset_pending=1)
BEGIN
  SELECT RAISE(ABORT, 'SYNC_STALE');
END;
CREATE TRIGGER sync_guard_reset_ack BEFORE INSERT ON sync_guards
WHEN NEW.operation='reset-ack' AND NOT EXISTS (SELECT 1 FROM sessions
  WHERE id=NEW.session_id AND (
    (reset_pending=1 AND reset_ack=json_extract(NEW.acks,'$[0]')) OR
    (reset_pending=0 AND last_reset_ack=json_extract(NEW.acks,'$[0]'))))
BEGIN
  SELECT RAISE(ABORT, 'SYNC_ACK_INVALID');
END;
CREATE TRIGGER sync_guard_state BEFORE INSERT ON sync_guards
WHEN NEW.operation NOT IN ('reset-ack','pending') AND EXISTS
  (SELECT 1 FROM sessions WHERE id=NEW.session_id AND reset_pending=1)
BEGIN
  SELECT RAISE(ABORT, 'SYNC_STALE');
END;
CREATE TRIGGER sync_guard_acks BEFORE INSERT ON sync_guards
WHEN NEW.operation='ack' AND EXISTS (
  SELECT 1 FROM json_each(NEW.acks) a WHERE
    (NEW.epoch<>'' AND substr(a.value,-37)<>'|' || NEW.epoch) OR
    NOT EXISTS (SELECT 1 FROM sync_checkpoints c
      WHERE c.session_id=NEW.session_id AND c.ack=a.value)
    AND NOT EXISTS (SELECT 1 FROM sync_deliveries d
      WHERE d.session_id=NEW.session_id AND d.ack=a.value
      AND d.issued_at>=MAX(NEW.now_ms, CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))-86400000))
AND EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND sync_epoch=NEW.epoch AND reset_pending=0)
BEGIN
  SELECT RAISE(ABORT, 'SYNC_ACK_INVALID');
END;
