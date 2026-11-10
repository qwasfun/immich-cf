export interface PhotoQuery {
  q: string;
  from: string;
  to: string;
  type: string;
  order: string;
}

export const emptyPhotoQuery: PhotoQuery = {
  q: '',
  from: '',
  to: '',
  type: 'all',
  order: 'newest',
};

export class PhotoQueryError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}

export function photoQuery(params: URLSearchParams): PhotoQuery {
  const query = { ...emptyPhotoQuery };
  for (const key of Object.keys(query) as (keyof PhotoQuery)[]) {
    if (params.getAll(key).length > 1)
      throw new PhotoQueryError(key, `${queryLabels[key]}：请只提供一个筛选值`);
    query[key] = params.get(key) ?? query[key];
  }
  query.q = query.q.trim();
  if (query.q.length > 100)
    throw new PhotoQueryError('q', '文件名：最多填写 100 个字符，请缩短搜索内容');
  for (const key of ['from', 'to'] as const) {
    const value = query[key];
    if (
      value &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value)
    )
      throw new PhotoQueryError(key, `${queryLabels[key]}：请提供有效的 UTC ISO 时间`);
  }
  if (query.from && query.to && query.from >= query.to)
    throw new PhotoQueryError('from/to', '拍摄开始时间、拍摄结束时间：开始时间必须早于结束时间');
  if (!['all', 'static', 'live', 'jpeg', 'png', 'heic'].includes(query.type))
    throw new PhotoQueryError(
      'type',
      '照片类型：请选择全部、静态照片、动态照片、JPEG、PNG 或 HEIC',
    );
  if (!['newest', 'oldest'].includes(query.order))
    throw new PhotoQueryError('order', '排序：请选择最新在前或最早在前');
  return query;
}

const queryLabels: Record<keyof PhotoQuery, string> = {
  q: '文件名',
  from: '拍摄开始时间',
  to: '拍摄结束时间',
  type: '照片类型',
  order: '排序',
};

export function photoQueryParams(query: PhotoQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(query) as (keyof PhotoQuery)[])
    if (query[key] !== emptyPhotoQuery[key]) params.set(key, query[key]);
  return params;
}

export const hasPhotoFilters = (query: PhotoQuery) =>
  !!(query.q || query.from || query.to || query.type !== 'all');
