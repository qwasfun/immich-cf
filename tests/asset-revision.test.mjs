import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
test('非空迁移保持旧资产游标，新插入和尺寸更新共用单调时钟并随事务回滚', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('owner')");
    db.exec(await readFile('migrations/0005_small_assets.sql', 'utf8'));
    const insert =
      db.prepare(`INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite)
      VALUES (?,'owner',?,'key','file','image/png',100,320,240,'date','date','date',0)`);
    insert.run('old', 'checksum1');
    db.exec(await readFile('migrations/0009_asset_sync_revision.sql', 'utf8'));
    const row = () => db.prepare("SELECT seq,sync_seq,width FROM assets WHERE id='old'").get();
    assert.equal(row().sync_seq, row().seq);
    db.exec("BEGIN; UPDATE assets SET width=240,height=320 WHERE id='old'; ROLLBACK");
    assert.equal(row().sync_seq, row().seq);
    db.exec("UPDATE assets SET width=240,height=320 WHERE id='old'");
    const revision = row().sync_seq;
    assert.ok(revision > row().seq);
    insert.run('new', 'checksum2');
    assert.ok(db.prepare("SELECT sync_seq FROM assets WHERE id='new'").get().sync_seq > revision);
    db.exec("UPDATE assets SET width=240,height=320 WHERE id='old'");
    assert.equal(row().sync_seq, revision);
  } finally {
    db.close();
  }
});
