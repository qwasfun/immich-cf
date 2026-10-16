-- Old objects did not carry a SHA-1 in R2. Preserve their existing read behavior.
-- New uploads and explicit same-image repairs require the R2 checksum from now on.
ALTER TABLE assets ADD COLUMN r2_sha1_verified INTEGER NOT NULL DEFAULT 0
  CHECK (r2_sha1_verified IN (0, 1));
