-- Durable fences are retained forever; bound pending recovery to an owner range.
CREATE INDEX r2_cleanup_owner_status_key ON r2_cleanup_claims(owner_id,status,object_key);
