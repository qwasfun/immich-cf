import { DatabaseSync } from 'node:sqlite';

// Independent minimal relational consumer, not the official App or its full schema.
// It makes owner/metadata FK order, transactional application and replay observable.
export class SyncClientModel {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE assets(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id),filename TEXT NOT NULL,favorite INTEGER NOT NULL,width INTEGER,height INTEGER);
      CREATE TABLE metadata(assetId TEXT REFERENCES assets(id) ON DELETE CASCADE,key TEXT,value TEXT,PRIMARY KEY(assetId,key));
      CREATE TABLE onboarding(userId TEXT PRIMARY KEY REFERENCES users(id),value TEXT);
      CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT,description TEXT,thumbnailAssetId TEXT REFERENCES assets(id) ON DELETE SET NULL,sortOrder TEXT);
      CREATE TABLE album_users(albumId TEXT REFERENCES albums(id) ON DELETE CASCADE,userId TEXT REFERENCES users(id),role TEXT,PRIMARY KEY(albumId,userId));
      CREATE TABLE album_assets(albumId TEXT REFERENCES albums(id) ON DELETE CASCADE,assetId TEXT REFERENCES assets(id) ON DELETE CASCADE,PRIMARY KEY(albumId,assetId));`);
  }
  apply(events, { reset = false, failAfter = -1 } = {}) {
    this.db.exec('BEGIN');
    try {
      if (reset) this.clear();
      for (const [index, event] of events.entries()) {
        const d = event.data;
        if (event.type === 'SyncResetV1') this.clear();
        if (event.type === 'UserV1')
          this.db.prepare('INSERT INTO users VALUES(?) ON CONFLICT DO NOTHING').run(d.id);
        if (['AssetV2', 'AlbumAssetCreateV2', 'AlbumAssetUpdateV2'].includes(event.type))
          this.db
            .prepare(
              `INSERT INTO assets VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ownerId=excluded.ownerId,filename=excluded.filename,favorite=excluded.favorite,width=excluded.width,height=excluded.height`,
            )
            .run(d.id, d.ownerId, d.originalFileName, d.isFavorite ? 1 : 0, d.width, d.height);
        if (event.type === 'AssetDeleteV1')
          this.db.prepare('DELETE FROM assets WHERE id=?').run(d.assetId);
        if (event.type === 'AssetMetadataV1')
          this.db
            .prepare(
              'INSERT INTO metadata VALUES(?,?,?) ON CONFLICT(assetId,key) DO UPDATE SET value=excluded.value',
            )
            .run(d.assetId, d.key, JSON.stringify(d.value));
        if (event.type === 'AssetMetadataDeleteV1')
          this.db.prepare('DELETE FROM metadata WHERE assetId=? AND key=?').run(d.assetId, d.key);
        if (event.type === 'UserMetadataV1' && d.key === 'onboarding')
          this.db
            .prepare(
              'INSERT INTO onboarding VALUES(?,?) ON CONFLICT(userId) DO UPDATE SET value=excluded.value',
            )
            .run(d.userId, JSON.stringify(d.value));
        if (event.type === 'UserMetadataDeleteV1' && d.key === 'onboarding')
          this.db.prepare('DELETE FROM onboarding WHERE userId=?').run(d.userId);
        if (event.type === 'AlbumV2')
          this.db
            .prepare(
              'INSERT INTO albums VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,thumbnailAssetId=excluded.thumbnailAssetId,sortOrder=excluded.sortOrder',
            )
            .run(d.id, d.name, d.description, d.thumbnailAssetId, d.order);
        if (event.type === 'AlbumDeleteV1')
          this.db.prepare('DELETE FROM albums WHERE id=?').run(d.albumId);
        if (event.type === 'AlbumUserV1')
          this.db
            .prepare(
              'INSERT INTO album_users VALUES(?,?,?) ON CONFLICT(albumId,userId) DO UPDATE SET role=excluded.role',
            )
            .run(d.albumId, d.userId, d.role);
        if (event.type === 'AlbumUserDeleteV1')
          this.db
            .prepare('DELETE FROM album_users WHERE albumId=? AND userId=?')
            .run(d.albumId, d.userId);
        if (event.type === 'AlbumToAssetV1')
          this.db
            .prepare('INSERT INTO album_assets VALUES(?,?) ON CONFLICT DO NOTHING')
            .run(d.albumId, d.assetId);
        if (event.type === 'AlbumToAssetDeleteV1')
          this.db
            .prepare('DELETE FROM album_assets WHERE albumId=? AND assetId=?')
            .run(d.albumId, d.assetId);
        if (index === failAfter) throw new Error('SIMULATED_CLIENT_CRASH');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  clear() {
    this.db.exec(
      'DELETE FROM album_assets; DELETE FROM album_users; DELETE FROM albums; DELETE FROM metadata; DELETE FROM assets; DELETE FROM onboarding; DELETE FROM users;',
    );
  }
  snapshot() {
    return Object.fromEntries(
      ['assets', 'metadata', 'onboarding'].map((table) => [
        table,
        this.db
          .prepare('SELECT * FROM ' + table + ' ORDER BY 1,2')
          .all()
          .map((row) => ({ ...row })),
      ]),
    );
  }
  albumSnapshot() {
    return Object.fromEntries(
      ['albums', 'album_users', 'album_assets'].map((table) => [
        table,
        this.db
          .prepare('SELECT * FROM ' + table + ' ORDER BY 1,2')
          .all()
          .map((row) => ({ ...row })),
      ]),
    );
  }
  close() {
    this.db.close();
  }
}
