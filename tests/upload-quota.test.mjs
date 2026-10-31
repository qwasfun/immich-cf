import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

test('非空配额迁移保留记录，只排除同所有者已发布预约；跨用户同哈希仍占名额', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('a'),('b')",
    );
    for (const file of [
      '0005_small_assets.sql',
      '0006_upload_intents.sql',
      '0009_asset_sync_revision.sql',
      '0011_r2_integrity.sql',
    ])
      db.exec(await readFile('migrations/' + file, 'utf8'));
    const asset = db.prepare(`INSERT INTO assets
      (id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite)
      VALUES (?,?,?,?,'fixture','image/png',100,1,1,'date','date','date',0)`);
    for (let i = 0; i < 19; i++) asset.run(`a-${i}`, 'a', `hash-${i}`, `a/key-${i}`);
    asset.run('b-asset', 'b', 'cross-owner-hash', 'b/key');
    const intent = db.prepare(
      'INSERT INTO upload_intents(owner_id,checksum,id,object_key,created_at) VALUES (?,?,?,?,?)',
    );
    intent.run('a', 'hash-0', 'old-0', 'a/old-0', 'date');
    intent.run('a', 'hash-1', 'old-1', 'a/old-1', 'date');
    assert.throws(
      () => intent.run('a', 'cross-owner-hash', 'pending', 'a/pending', 'date'),
      /ASSET_LIMIT/,
    );
    const snapshot = () => ({
      assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
      intents: db.prepare('SELECT * FROM upload_intents ORDER BY id').all(),
      clock: db.prepare('SELECT * FROM asset_sync_clock').all(),
    });
    const before = snapshot();
    db.exec(await readFile('migrations/0012_upload_quota_identity.sql', 'utf8'));
    assert.deepEqual(snapshot(), before);
    intent.run('a', 'cross-owner-hash', 'pending', 'a/pending', 'date');
    assert.throws(() => intent.run('a', 'new-hash', 'denied', 'a/denied', 'date'), /ASSET_LIMIT/);
    // Reusing an existing reservation does not require another slot.
    db.prepare(
      'INSERT INTO upload_intents(owner_id,checksum,id,object_key,created_at) VALUES (?,?,?,?,?) ON CONFLICT(owner_id,checksum) DO NOTHING',
    ).run('a', 'cross-owner-hash', 'retry', 'a/retry', 'date');
    asset.run('published', 'a', 'cross-owner-hash', 'a/pending');
    assert.throws(() => intent.run('a', 'new-hash', 'denied', 'a/denied', 'date'), /ASSET_LIMIT/);
    assert.deepEqual(
      db
        .prepare("SELECT id,object_key FROM upload_intents WHERE id LIKE 'old-%' ORDER BY id")
        .all()
        .map((row) => [row.id, row.object_key]),
      before.intents.map((row) => [row.id, row.object_key]),
    );
    intent.run('b', 'b-new', 'b-pending', 'b/pending', 'date');
  } finally {
    db.close();
  }
});
