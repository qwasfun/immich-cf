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
  async function get(path, maxResponseBytes = 2 * 1024 * 1024) {
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
    if (r.metrics.errorCode || r.metrics.status !== 200)
      throw Error('导出请求：未取得完整有效响应，请检查授权、网络或重新导出');
    return r.bytes;
  }
  const path = '/api/immich-cf/admin/export?userId=' + encodeURIComponent(userId);
  const manifest = JSON.parse((await get(path)).toString('utf8'));
  if (
    !['immich-cf-account-v1', 'immich-cf-account-v2'].includes(manifest.format) ||
    manifest.ownerId !== userId ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length > (manifest.format === 'immich-cf-account-v2' ? 40 : 20) ||
    !Array.isArray(manifest.albums) ||
    !Array.isArray(manifest.relations)
  )
    throw Error('清单：格式、账号或范围不正确');
  const dir = resolve(out);
  await mkdir(dir); // A fresh folder prevents overwriting an existing export.
  await writeFile(join(dir, 'INCOMPLETE'), '导出未完成，不能作为完整备份\n', { flag: 'wx' });
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
    const linked = new Set();
    for (const asset of manifest.assets) {
      if (!asset.live_photo_video_id) continue;
      const video = manifest.assets.find((v) => v.id === asset.live_photo_video_id);
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
  }
  const latest = JSON.parse((await get(path)).toString('utf8'));
  for (const key of ['assets', 'albums', 'relations'])
    if (JSON.stringify(latest[key]) !== JSON.stringify(manifest[key]))
      throw Error('清单：下载期间图库发生变化，请保留此目录并重新导出到新目录');
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
