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
    for (const name of tables) {
      const original = before.get(name);
      const columns = Object.keys(original[0]);
      assert.deepEqual(db.prepare('SELECT ' + columns.join(',') + ' FROM ' + name).all(), original);
    }
    assert.equal(db.prepare('SELECT updated_at FROM assets').get().updated_at, 'date');
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
    const pendingPlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT object_key FROM r2_cleanup_claims WHERE owner_id=? AND status='claimed' AND object_key>? ORDER BY object_key LIMIT 21",
      )
      .all('owner', '');
    assert.ok(pendingPlan.some((row) => row.detail.includes('r2_cleanup_owner_status_key')));

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

test('R2 清理持久隔离覆盖所有引用表 INSERT/UPDATE，跨账号引用也不能认领', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of (await readdir('migrations')).filter((x) => x.endsWith('.sql')).sort())
      db.exec(await readFile('migrations/' + file, 'utf8'));
    db.exec(`INSERT INTO users(id,email,name,password_hash,created_at,update_id) VALUES('owner','owner@example.invalid','local','not-a-login-hash','date','version');
      INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite) VALUES('asset','owner','sum','live','file.png','image/png',32,1,1,'date','date','date',0);
      INSERT INTO retired_assets VALUES('retired','owner','retired-key',NULL,32,'sum',0,'date');
      INSERT INTO upload_intents(owner_id,checksum,id,object_key,created_at) VALUES('owner','pending','intent','pending-key','date');
      INSERT INTO integrity_copy_intents VALUES('staging-key','owner','asset');`);
    for (const key of ['live', 'retired-key', 'pending-key', 'staging-key'])
      assert.throws(
        () =>
          db.prepare("INSERT INTO r2_cleanup_claims VALUES(?,'other-owner','claimed')").run(key),
        /R2_REFERENCED/,
      );
    db.exec("INSERT INTO r2_cleanup_claims VALUES('fenced','owner','claimed')");
    for (const table of ['assets', 'retired_assets', 'upload_intents', 'integrity_copy_intents']) {
      assert.throws(() => db.exec(`UPDATE ${table} SET object_key='fenced'`), /R2_CLEANUP_CLAIMED/);
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((x) => x.name);
      const values = columns.map((x) => (x === 'object_key' ? "'fenced'" : x));
      assert.throws(
        () =>
          db.exec(
            `INSERT INTO ${table}(${columns.join(',')}) SELECT ${values.join(',')} FROM ${table}`,
          ),
        /R2_CLEANUP_CLAIMED/,
      );
    }
    for (const table of ['assets', 'retired_assets']) {
      assert.throws(
        () => db.exec(`UPDATE ${table} SET integrity_source_key='fenced'`),
        /R2_CLEANUP_CLAIMED/,
      );
    }
    assert.throws(
      () => db.exec("UPDATE r2_cleanup_claims SET object_key='released'"),
      /R2_FENCE_PERMANENT/,
    );
    db.exec("UPDATE r2_cleanup_claims SET status='done'");
    assert.throws(() => db.exec('DELETE FROM r2_cleanup_claims'), /R2_FENCE_PERMANENT/);
  } finally {
    db.close();
  }
});
