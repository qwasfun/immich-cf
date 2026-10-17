import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

test('非空摘要源迁移仅新增空源引用，保留历史资产、原图路径、预约和同步时钟', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('owner')",
    );
    for (const name of [
      '0005_small_assets.sql',
      '0006_upload_intents.sql',
      '0009_asset_sync_revision.sql',
      '0011_r2_integrity.sql',
      '0012_upload_quota_identity.sql',
    ])
      db.exec(await readFile('migrations/' + name, 'utf8'));
    db.exec(`INSERT INTO assets (id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite)
      VALUES ('asset','owner','checksum','retained-original','fixture.png','image/png',32,1,1,'date','date','date',0);
      INSERT INTO upload_intents VALUES ('owner','checksum','intent','retained-intent','date')`);
    const assets = db.prepare('SELECT * FROM assets').all();
    const intents = db.prepare('SELECT * FROM upload_intents').all();
    const clock = db.prepare('SELECT * FROM asset_sync_clock').all();
    db.exec(await readFile('migrations/0013_integrity_source.sql', 'utf8'));
    assert.deepEqual(
      db
        .prepare('SELECT * FROM assets')
        .all()
        .map((row) => ({ ...row })),
      assets.map((row) => ({ ...row, integrity_source_key: null })),
    );
    assert.deepEqual(db.prepare('SELECT * FROM upload_intents').all(), intents);
    assert.deepEqual(db.prepare('SELECT * FROM asset_sync_clock').all(), clock);
  } finally {
    db.close();
  }
});
