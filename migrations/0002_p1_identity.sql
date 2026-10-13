-- P1 实验账户仅通过本机脚本创建，不开放注册接口。
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  update_id TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  reset_pending INTEGER NOT NULL DEFAULT 0 CHECK (reset_pending IN (0, 1))
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE sync_checkpoints (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  ack TEXT NOT NULL,
  PRIMARY KEY (session_id, type)
);
CREATE TABLE sync_deliveries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  ack TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, ack)
);
CREATE TABLE login_buckets (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
