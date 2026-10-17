-- Retain a durable source reference when atomically switching to a verified copy.
ALTER TABLE assets ADD COLUMN integrity_source_key TEXT;
