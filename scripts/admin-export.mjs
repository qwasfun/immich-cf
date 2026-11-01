import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { curlRequest } from './lib/curl-request.mjs';

export async function exportAccount({
  baseUrl,
  userId,
  credentials,
  out,
  proxy,
  request = curlRequest,
}) {
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    !(
      base.protocol === 'https:' ||
      (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))
    )
  )
    throw Error('base-url：请使用HTTPS服务根地址或本机HTTP根地址');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(userId))
    throw Error('user-id：请提供UUID v4');
  let accessToken;
  try {
    ({ accessToken } = JSON.parse(await readFile(credentials, 'utf8')));
  } catch {
    throw Error('credentials：请提供可读取的有效JSON凭据文件');
  }
  if (typeof accessToken !== 'string' || !/^[a-f0-9]{64}$/i.test(accessToken))
    throw Error('credentials：请提供含有效accessToken的本机JSON文件');
  async function get(path, maxResponseBytes = 2 * 1024 * 1024, allowLegacy = false) {
    let r;
    for (let n = 0; n < 3; n++) {
      r = await request(base.origin + path, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        tls12: true,
        timeoutMs: 120000,
        maxResponseBytes,
        ...(proxy ? { proxy } : {}),
      });
      if (!r.metrics.errorCode && ![502, 503, 504].includes(r.metrics.status)) break;
    }
    if (allowLegacy && !r.metrics.errorCode && [404, 405, 501].includes(r.metrics.status))
      return undefined;
    if (r.metrics.errorCode || r.metrics.status !== 200)
      throw Error('导出请求：未取得完整有效响应，请检查授权、网络或重新导出');
    return r.bytes;
  }
  const path = '/api/immich-cf/admin/export?userId=' + encodeURIComponent(userId);
  const pagePath = '/api/immich-cf/admin/export/page?userId=' + encodeURIComponent(userId);
  const dir = resolve(out);
  await mkdir(dir);
  await writeFile(join(dir, 'INCOMPLETE'), '导出未完成，不能作为完整备份\n', { flag: 'wx' });
  const first = await get(pagePath, 2 * 1024 * 1024, true);
  let manifest, completionPath, snapshot, totals, exportedAt;
  if (first === undefined) manifest = JSON.parse((await get(path)).toString('utf8'));
  else {
    const arrays = { assets: [], albums: [], relations: [] },
      max = { assets: 20000, albums: 100, relations: 1000000 };
    const kinds = ['assets', 'albums', 'relations', 'complete'],
      sizes = [50, 20, 2000, 0];
    const lastKeys = {},
      seenCursors = new Set();
    let data = JSON.parse(first.toString('utf8')),
      requestPath = pagePath,
      priorKind = 0;
    for (let page = 0; ; page++) {
      if (
        page > 2000 ||
        data.format !== 'immich-cf-account-pages-v1' ||
        data.manifestFormat !== 'immich-cf-account-v2' ||
        data.ownerId !== userId ||
        !data.includesTrash ||
        data.fullDatabaseBackup !== false
      )
        throw Error('分页清单：格式、账号或页数无效，导出未完成');
      if (page === 0) {
        snapshot = data.snapshot;
        totals = data.totals;
        exportedAt = data.exportedAt;
        if (
          !snapshot ||
          !['assetRevision', 'albumRevision'].every(
            (k) => Number.isSafeInteger(snapshot[k]) && snapshot[k] >= 0,
          ) ||
          !totals ||
          !Object.keys(max).every(
            (k) => Number.isSafeInteger(totals[k]) && totals[k] >= 0 && totals[k] <= max[k],
          ) ||
          typeof exportedAt !== 'string'
        )
          throw Error('分页清单：版本或总数无效，导出未完成');
      }
      if (
        JSON.stringify(data.snapshot) !== JSON.stringify(snapshot) ||
        JSON.stringify(data.totals) !== JSON.stringify(totals) ||
        data.exportedAt !== exportedAt
      )
        throw Error('分页清单：图库版本已变化，导出未完成');
      const kind = kinds.indexOf(data.page?.kind);
      if (
        kind < priorKind ||
        kind > priorKind + 1 ||
        (page === 0 && kind !== 0) ||
        !Array.isArray(data.page?.items) ||
        data.page.items.length > sizes[kind]
      )
        throw Error('分页清单：顺序或单页范围无效，导出未完成');
      priorKind = kind;
      if (kind === 3) {
        if (
          data.page.nextCursor !== null ||
          data.page.items.length ||
          !Object.keys(arrays).every((k) => arrays[k].length === totals[k])
        )
          throw Error('分页清单：项目缺失或总数不符，导出未完成');
        completionPath = requestPath;
        break;
      }
      const name = kinds[kind];
      for (const row of data.page.items) {
        const ids = kind === 2 ? [row.album_id, row.asset_id] : [row.id];
        if (ids.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)))
          throw Error('分页清单：项目 ID 无效，导出未完成');
        const key = ids.join(':');
        if (lastKeys[name] !== undefined && key <= lastKeys[name])
          throw Error('分页清单：存在重复或乱序项目，导出未完成');
        lastKeys[name] = key;
        arrays[name].push(row);
      }
      if (arrays[name].length > totals[name]) throw Error('分页清单：项目总数溢出，导出未完成');
      const cursor = data.page.nextCursor;
      if (
        typeof cursor !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,2048}$/.test(cursor) ||
        seenCursors.has(cursor)
      )
        throw Error('分页清单：缺少有效后续游标，导出未完成');
      seenCursors.add(cursor);
      requestPath = pagePath + '&cursor=' + encodeURIComponent(cursor);
      data = JSON.parse((await get(requestPath)).toString('utf8'));
    }
    manifest = {
      format: 'immich-cf-account-v2',
      ownerId: userId,
      exportedAt,
      includesTrash: true,
      fullDatabaseBackup: false,
      ...arrays,
      snapshot,
      totals,
    };
  }
  if (
    !['immich-cf-account-v1', 'immich-cf-account-v2'].includes(manifest.format) ||
    manifest.ownerId !== userId ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length > (manifest.format === 'immich-cf-account-v2' ? 20000 : 10000) ||
    !Array.isArray(manifest.albums) ||
    manifest.albums.length > 100 ||
    !Array.isArray(manifest.relations) ||
    manifest.relations.length > 1000000
  )
    throw Error('清单：格式、账号或范围不正确');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  const seen = new Set();
  for (const asset of manifest.assets) {
    if (
      !/^[a-f0-9-]{36}$/i.test(asset.id) ||
      seen.has(asset.id) ||
      ![
        'image/jpeg',
        'image/png',
        ...(manifest.format === 'immich-cf-account-v2' ? ['image/heic', 'video/quicktime'] : []),
      ].includes(asset.mime) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      asset.bytes >
        (manifest.format === 'immich-cf-account-v1'
          ? 4194304
          : asset.mime === 'video/quicktime'
            ? 64 * 1024 * 1024
            : 20000000) ||
      typeof asset.checksum !== 'string'
    )
      throw Error('资产清单：ID、格式、大小或校验值无效');
    if (
      manifest.format === 'immich-cf-account-v2' &&
      (asset.mime === 'video/quicktime'
        ? asset.media_type !== 'VIDEO' || asset.visibility !== 'hidden' || asset.live_photo_video_id
        : asset.media_type !== 'IMAGE')
    )
      throw Error('资产清单：媒体类型、可见性或配对字段无效');
    seen.add(asset.id);
    const expected = `/api/immich-cf/admin/export/original?userId=${userId}&id=${asset.id}&revision=${asset.sync_seq}`;
    if (asset.downloadPath !== expected) throw Error('下载路径：与清单账号或资产不匹配');
    const bytes = await get(expected, asset.bytes);
    if (
      bytes.length !== asset.bytes ||
      createHash('sha1').update(bytes).digest('base64') !== asset.checksum
    )
      throw Error('原图：字节数或SHA-1不符，导出未完成');
    await writeFile(
      join(
        dir,
        asset.id +
          {
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/heic': '.heic',
            'video/quicktime': '.mov',
          }[asset.mime],
      ),
      bytes,
      {
        flag: 'wx',
      },
    );
  }
  if (manifest.format === 'immich-cf-account-v2') {
    const linked = new Set(),
      byId = new Map(manifest.assets.map((a) => [a.id, a]));
    for (const asset of manifest.assets) {
      if (!asset.live_photo_video_id) continue;
      const video = byId.get(asset.live_photo_video_id);
      if (
        asset.media_type !== 'IMAGE' ||
        asset.visibility !== 'timeline' ||
        !video ||
        video.media_type !== 'VIDEO' ||
        video.mime !== 'video/quicktime' ||
        video.visibility !== 'hidden' ||
        video.deleted_at !== asset.deleted_at ||
        linked.has(video.id)
      )
        throw Error('Live Photo 配对：照片与动态原件不完整或关系冲突，导出未完成');
      linked.add(video.id);
    }
    if (manifest.assets.some((a) => a.media_type === 'VIDEO' && !linked.has(a.id)))
      throw Error('Live Photo 配对：存在尚未配对的动态原件，导出未完成');
    if (manifest.assets.length - linked.size > 10000)
      throw Error('资产清单：超过 10,000 个逻辑资产，导出未完成');
  }
  const albumIds = new Set(),
    relations = new Set(),
    byId = new Map(manifest.assets.map((a) => [a.id, a]));
  for (const album of manifest.albums) {
    if (
      typeof album.id !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(album.id) ||
      albumIds.has(album.id)
    )
      throw Error('相册清单：ID 无效或重复，导出未完成');
    albumIds.add(album.id);
  }
  for (const relation of manifest.relations) {
    const key = relation.album_id + ':' + relation.asset_id;
    if (
      !albumIds.has(relation.album_id) ||
      !byId.has(relation.asset_id) ||
      byId.get(relation.asset_id).media_type === 'VIDEO' ||
      relations.has(key)
    )
      throw Error('相册关系：照片或相册缺失、重复或引用了隐藏视频，导出未完成');
    relations.add(key);
  }
  for (const album of manifest.albums)
    if (album.thumbnail_asset_id && !relations.has(album.id + ':' + album.thumbnail_asset_id))
      throw Error('相册封面：未关联到对应照片，导出未完成');
  if (completionPath) {
    const latest = JSON.parse((await get(completionPath)).toString('utf8'));
    if (
      latest.format !== 'immich-cf-account-pages-v1' ||
      latest.ownerId !== userId ||
      latest.page?.kind !== 'complete' ||
      latest.page.nextCursor !== null ||
      !Array.isArray(latest.page.items) ||
      latest.page.items.length ||
      JSON.stringify(latest.snapshot) !== JSON.stringify(snapshot) ||
      JSON.stringify(latest.totals) !== JSON.stringify(totals) ||
      latest.exportedAt !== exportedAt
    )
      throw Error('清单：下载期间图库或相册关系发生变化，导出未完成');
  } else {
    const latest = JSON.parse((await get(path)).toString('utf8'));
    for (const key of ['assets', 'albums', 'relations'])
      if (JSON.stringify(latest[key]) !== JSON.stringify(manifest[key]))
        throw Error('清单：下载期间图库发生变化，请保留此目录并重新导出到新目录');
  }
  await writeFile(
    join(dir, 'INCOMPLETE'),
    JSON.stringify(
      {
        format: manifest.format,
        completedAt: new Date().toISOString(),
        assets: seen.size,
        hashVerified: true,
        fullDatabaseBackup: false,
      },
      null,
      2,
    ) + '\n',
  );
  await rename(join(dir, 'INCOMPLETE'), join(dir, 'COMPLETE.json'));
  return { assets: seen.size, hashVerified: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--base-url', '--user-id', '--credentials', '--out', '--proxy'].includes(args[i]) ||
      !args[i + 1]
    )
      throw Error('参数：请提供--base-url、--user-id、--credentials、--out，可选--proxy');
    values[args[i].slice(2)] = args[i + 1];
  }
  console.log(
    JSON.stringify(
      await exportAccount({
        baseUrl: values['base-url'],
        userId: values['user-id'],
        credentials: values.credentials,
        out: values.out,
        ...(values.proxy ? { proxy: values.proxy } : {}),
      }),
    ),
  );
}
