-- Durable negative evidence; no expiry that could silently permit a later still retry.
CREATE TABLE live_photo_blocks (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_key TEXT NOT NULL,
  PRIMARY KEY(owner_id,pair_key)
);
