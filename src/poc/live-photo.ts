import { digest, HttpError, invalid } from './http';

// Official v3.3.1 foreground uploads reuse these fields for both halves.
// This is negative evidence, not a claim that unmarked files are standalone photos.
export async function guardLivePhoto(form: FormData, db: D1Database, owner: string) {
  const device = form.get('deviceId');
  const asset = form.get('deviceAssetId');
  for (const [field, value] of [
    ['deviceId', device],
    ['deviceAssetId', asset],
  ] as const)
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 255))
      invalid(field, '必须为非空字符串，最多 255 字符');
  const pair =
    typeof device === 'string' && typeof asset === 'string'
      ? await digest(JSON.stringify([device, asset]))
      : null;
  const marked = form.get('visibility') === 'hidden' || form.has('livePhotoVideoId');
  try {
    if (marked && pair) {
      // Bound storage per owner. Saturation fails closed for this owner, never evicts evidence.
      await db
        .prepare(
          `INSERT OR IGNORE INTO live_photo_blocks(owner_id,pair_key)
        SELECT ?, CASE WHEN (SELECT COUNT(*) FROM live_photo_blocks WHERE owner_id=?) >= 256
        AND NOT EXISTS (SELECT 1 FROM live_photo_blocks WHERE owner_id=? AND pair_key=?)
        THEN '*' ELSE ? END`,
        )
        .bind(owner, owner, owner, pair, pair)
        .run();
    }
    if (!marked) {
      const blocked = await db
        .prepare(
          "SELECT pair_key FROM live_photo_blocks WHERE owner_id=? AND (pair_key='*' OR pair_key=?) ORDER BY pair_key LIMIT 1",
        )
        .bind(owner, pair ?? '')
        .first<{ pair_key: string }>();
      if (blocked?.pair_key === '*')
        invalid(
          'assetData',
          '账户的 Live Photo 拦截记录已达上限，上传已暂停；请停止备份、保留原件并联系管理员评估',
        );
      if (blocked)
        invalid(
          'assetData',
          '此设备资产曾提交 Live Photo 动态部分，当前不支持完整备份；请从备份相册移除此项，保留手机原件',
        );
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      'assetData：无法确认 Live Photo 备份状态，请稍后重试并保留手机原件',
      'assetData',
    );
  }
}
