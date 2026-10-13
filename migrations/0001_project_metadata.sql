-- 仅建立项目元数据。用户、资产和 Sync 表在 P0 契约冻结后设计。
CREATE TABLE project_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

INSERT INTO project_metadata (key, value) VALUES ('project_name', 'immich-cf');
