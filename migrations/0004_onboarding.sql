CREATE TABLE user_onboarding (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_onboarded INTEGER NOT NULL CHECK (is_onboarded IN (0, 1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);
