import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';

async function database(migrate = true) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const files = (await readdir('migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files.filter((f) => f < '0029'))
    db.exec(await readFile('migrations/' + file, 'utf8'));
  db.exec(
    `INSERT INTO users(id,email,name,password_hash,created_at,update_id) VALUES('a','a@example.invalid','a','not-a-login-hash','date','version'),('b','b@example.invalid','b','not-a-login-hash','date','version');`,
  );
  if (migrate) db.exec(await readFile('migrations/0029_asset_capacity.sql', 'utf8'));
  return db;
}
function insert(db, id, owner = 'a', pair = null, video = null, type = 'IMAGE') {
  db.prepare(
    `INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite,pair_id,live_photo_video_id,media_type,visibility,logical_key) VALUES(?,?,?,?,?,'image/png',1,1,1,'date','date','date',0,?,?,?,?,?)`,
  ).run(
    id,
    owner,
    'sum-' + id,
    owner + '/' + id,
    id,
    pair,
    video,
    type,
    type === 'VIDEO' ? 'hidden' : 'timeline',
    pair ? 'live:' + pair : '',
  );
}
const usage = (db, owner = 'a') =>
  db.prepare('SELECT logical_assets n FROM asset_owner_usage WHERE owner_id=?').get(owner)?.n ?? 0;
const consistent = (db) => {
  for (const owner of ['a', 'b']) {
    const expected = new Map();
    for (const row of db
      .prepare(
        'SELECT logical_key,checksum FROM assets WHERE owner_id=? UNION ALL SELECT logical_key,checksum FROM upload_intents WHERE owner_id=?',
      )
      .all(owner, owner)) {
      const key = row.logical_key || 'sha1:' + row.checksum;
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    assert.equal(usage(db, owner), expected.size);
    assert.deepEqual(
      db
        .prepare('SELECT slot,refs FROM asset_slot_references WHERE owner_id=? ORDER BY slot')
        .all(owner)
        .map((r) => [r.slot, r.refs]),
      [...expected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    assert.equal(
      usage(db, owner),
      db.prepare('SELECT COUNT(*) n FROM logical_asset_slots WHERE owner_id=?').get(owner).n,
    );
    assert.equal(
      db
        .prepare('SELECT COALESCE(SUM(refs),0) n FROM asset_slot_references WHERE owner_id=?')
        .get(owner).n,
      db
        .prepare(
          'SELECT (SELECT COUNT(*) FROM assets WHERE owner_id=?)+(SELECT COUNT(*) FROM upload_intents WHERE owner_id=?) n',
        )
        .get(owner, owner).n,
    );
  }
};
test('容量前向迁移保留原件、配对、重复预约和检查点，引用计数正确释放', async () => {
  const db = await database(false);
  try {
    insert(db, 'still');
    insert(db, 'motion', 'a', 'pair', null, 'VIDEO');
    insert(db, 'photo', 'a', 'pair', 'motion');
    db.exec(`INSERT INTO upload_intents(owner_id,checksum,id,object_key,created_at,logical_key,media_role) VALUES('a','sum-photo','duplicate','a/dup','date','live:pair','IMAGE'),('a','new','pending','a/pending','date','','IMAGE');
    INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES('session','a','not-a-token',9999999999999);
    INSERT INTO sync_checkpoints VALUES('session','AssetV2','AssetV2|00000000000000000001');`);
    const tables = [
      'assets',
      'upload_intents',
      'sync_checkpoints',
      'sessions',
      'asset_sync_clock',
      'asset_owner_revisions',
    ];
    const snapshot = tables.map((t) => db.prepare('SELECT * FROM ' + t).all());
    db.exec(await readFile('migrations/0029_asset_capacity.sql', 'utf8'));
    assert.deepEqual(
      tables.map((t) => db.prepare('SELECT * FROM ' + t).all()),
      snapshot,
    );
    assert.equal(db.prepare('SELECT logical_limit n FROM asset_quota_config').get().n, 10000);
    assert.equal(usage(db), 3);
    consistent(db);
    db.exec(
      "DELETE FROM upload_intents WHERE id='duplicate'; DELETE FROM assets WHERE id='photo';",
    );
    assert.equal(usage(db), 3);
    consistent(db);
    db.exec("DELETE FROM assets WHERE id='motion'; DELETE FROM upload_intents WHERE id='pending';");
    assert.equal(usage(db), 1);
    consistent(db);
  } finally {
    db.close();
  }
});
test('10,000 逻辑名额边界、Live Photo 双原件、回收站、重试与跨账号隔离', async () => {
  const db = await database();
  try {
    db.exec('BEGIN');
    for (let i = 0; i < 9999; i++) insert(db, 'seed-' + i);
    db.exec('COMMIT');
    insert(db, 'last-video', 'a', 'last', null, 'VIDEO');
    insert(db, 'last-photo', 'a', 'last', 'last-video');
    assert.equal(usage(db), 10000);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM assets WHERE owner_id='a'").get().n, 10001);
    assert.throws(() => insert(db, 'overflow'), /ASSET_LIMIT/);
    const intent = db.prepare(
      'INSERT INTO upload_intents(owner_id,checksum,id,object_key,created_at,logical_key,media_role) VALUES(?,?,?,?,?,?,?)',
    );
    assert.throws(() => intent.run('a', 'new', 'new', 'a/new', 'date', '', null), /ASSET_LIMIT/);
    intent.run('a', 'sum-last-photo', 'retry', 'a/retry', 'date', 'live:last', 'IMAGE');
    assert.equal(usage(db), 10000);
    db.exec(
      "UPDATE assets SET deleted_at='trash' WHERE pair_id='last'; DELETE FROM upload_intents WHERE id='retry'; UPDATE assets SET checksum='replacement' WHERE id='seed-0'",
    );
    assert.equal(usage(db), 10000);
    consistent(db);
    db.exec("DELETE FROM assets WHERE pair_id='last'");
    assert.equal(usage(db), 9999);
    intent.run('a', 'reserved', 'pending', 'a/pending', 'date', '', null);
    assert.throws(
      () => intent.run('a', 'reserved2', 'pending2', 'a/pending2', 'date', '', null),
      /ASSET_LIMIT/,
    );
    db.exec("UPDATE upload_intents SET checksum='changed-pending' WHERE id='pending'");
    assert.equal(usage(db), 10000);
    insert(db, 'cross-owner', 'b');
    assert.equal(usage(db, 'b'), 1);
    consistent(db);
    const before = db.prepare('SELECT * FROM asset_owner_usage ORDER BY owner_id').all();
    assert.throws(
      () =>
        db.exec(
          "UPDATE upload_intents SET owner_id='a' WHERE id='missing'; INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite) VALUES('bad','a','bad','bad','bad','image/png',1,1,1,'date','date','date',0)",
        ),
      /ASSET_LIMIT/,
    );
    assert.deepEqual(db.prepare('SELECT * FROM asset_owner_usage ORDER BY owner_id').all(), before);
  } finally {
    db.close();
  }
});
