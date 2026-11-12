import type { Asset } from '../poc/assets';
import { originalMatches } from '../poc/integrity';
import { inspectMedia } from '../poc/media-format';
import { HttpError } from '../poc/http';

export async function readPhotoExif(env: Env, row: Asset) {
  const head = await env.IMMICH_CF_MEDIA.head(row.object_key);
  if (!originalMatches(head, row.bytes, row.checksum, !!row.r2_sha1_verified))
    throw new HttpError(
      503,
      '照片原件：缺失或校验不符，请确认原件可用后重试；已保存的资料保持不变',
    );
  const media = await inspectMedia(env.IMMICH_CF_MEDIA, row.object_key, row.bytes);
  return media.exif ?? {};
}
