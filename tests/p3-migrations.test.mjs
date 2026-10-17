import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';

test('P3 非空0013数据库前向迁移保留资产、预约、源引用、会话检查点和单调时钟', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  try {
    const files = (await readdir('migrations')).filter((x) => x.endsWith('.sql')).sort();
    for (const file of files.filter((x) => x < '0014'))
      db.exec(await readFile('migrations/' + file, 'utf8'));
    db.exec(`INSERT INTO users(id,email,name,password_hash,created_at,update_id) VALUES('owner','local@example.invalid','local','not-a-login-hash','2026-01-01','version');
  INSERT INTO sessions(id,user_id,token_hash,expires_at,sync_epoch) VALUES('session','owner','not-a-real-token',9999999999999,'epoch');
  INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite,integrity_source_key) VALUES('asset','owner','checksum','original','file.png','image/png',32,320,240,'date','date','date',0,'retained-source');
  UPDATE assets SET width=321 WHERE id='asset';
  INSERT INTO upload_intents(owner_id,checksum,id,object_key,created_at) VALUES('owner','pending-checksum','pending','pending-original','date');
  INSERT INTO sync_checkpoints VALUES('session','AssetV2','AssetV2|00000000000000000001|epoch');`);
    const tables = ['assets', 'upload_intents', 'asset_sync_clock', 'sync_checkpoints'];
    const before = new Map(tables.map((name) => [name, db.prepare('SELECT * FROM ' + name).all()]));
    for (const file of files.filter((x) => x >= '0014'))
      db.exec(await readFile('migrations/' + file, 'utf8'));
    for (const name of tables)
      assert.deepEqual(db.prepare('SELECT * FROM ' + name).all(), before.get(name));
    assert.equal(
      db.prepare('SELECT revision FROM asset_owner_revisions').get().revision,
      db.prepare('SELECT sync_seq FROM assets').get().sync_seq,
    );
    assert.deepEqual(
      { ...db.prepare('SELECT asset_history_floor,metadata_history_floor FROM sessions').get() },
      { asset_history_floor: 0, metadata_history_floor: 0 },
    );
    assert.equal(db.prepare('SELECT COUNT(*) n FROM retired_assets').get().n, 0);
    assert.equal(db.prepare('PRAGMA table_info(sync_guards)').all().length, 6);
    db.exec(
      "INSERT INTO sync_guards VALUES('legacy-guard','session','epoch','stream','[]',0); DELETE FROM sync_guards WHERE id='legacy-guard'",
    );
    db.exec(
      "UPDATE assets SET metadata='[{\"key\":\"mobile-app\",\"value\":{}}]' WHERE id='asset'; UPDATE assets SET metadata='[]' WHERE id='asset'",
    );
    assert.equal(
      db.prepare('SELECT asset_id FROM asset_metadata_tombstones').get().asset_id,
      'asset',
    );
  } finally {
    db.close();
  }
});
