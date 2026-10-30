-- Explicit operator grants; no implicit first-user or email-based escalation.
CREATE TABLE operations_admins(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);
