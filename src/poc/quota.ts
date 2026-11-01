import { HttpError } from './http';

export async function assetQuota(db: D1Database, owner: string) {
  const row = await db
    .prepare(
      `SELECT logical_limit limitValue,COALESCE((SELECT logical_assets FROM asset_owner_usage WHERE owner_id=?),0) used FROM asset_quota_config WHERE id=1`,
    )
    .bind(owner)
    .first<{ limitValue: number; used: number }>();
  if (!row) throw new HttpError(503, 'assetData：资产名额配置暂不可用，请稍后重试', 'assetData');
  return row;
}
export function assetLimit(limit: number, missingMotion = false): never {
  throw new HttpError(
    409,
    `assetData：账户已达 ${limit.toLocaleString('en-US')} 个逻辑资产上限（含回收站和待完成上传）${missingMotion ? '，动态视频尚未完成，照片也不能完成整组备份' : ''}；请先确认已有项目已另行备份，再永久删除不需要的项目以释放名额，然后重试备份`,
    'assetData',
  );
}
