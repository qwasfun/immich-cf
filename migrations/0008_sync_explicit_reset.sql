-- Explicit client reset can atomically replace either active or pending progress.
DROP TRIGGER sync_guard_state;
CREATE TRIGGER sync_guard_state BEFORE INSERT ON sync_guards
WHEN NEW.operation NOT IN ('reset-ack','pending','reset-snapshot') AND EXISTS
  (SELECT 1 FROM sessions WHERE id=NEW.session_id AND reset_pending=1)
BEGIN
  SELECT RAISE(ABORT, 'SYNC_STALE');
END;

-- On an old generation, leave rejection to sync_guard_session regardless of trigger order.
DROP TRIGGER sync_guard_reset_ack;
CREATE TRIGGER sync_guard_reset_ack BEFORE INSERT ON sync_guards
WHEN NEW.operation='reset-ack'
AND EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND sync_epoch=NEW.epoch)
AND NOT EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND (
  (reset_pending=1 AND reset_ack=json_extract(NEW.acks,'$[0]')) OR
  (reset_pending=0 AND last_reset_ack=json_extract(NEW.acks,'$[0]'))))
BEGIN
  SELECT RAISE(ABORT, 'SYNC_ACK_INVALID');
END;
