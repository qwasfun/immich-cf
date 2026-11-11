export class PhotoLabelError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}
export const tagKey = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
export function tagName(value: unknown): string {
  if (typeof value !== 'string') throw new PhotoLabelError('tags', '标签：必须填写文本名称');
  const name = value.normalize('NFKC').trim();
  if (!name || Array.from(name).length > 32 || /[\x00-\x1f\x7f]/.test(name))
    throw new PhotoLabelError('tags', '标签：每项填写 1～32 个字符，不能包含换行或控制字符');
  return name;
}
export function photoTags(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new PhotoLabelError('tags', '标签：请提供标签名称数组，每张最多 20 项');
  if (value.length > 20)
    throw new PhotoLabelError('tags', '标签：每张照片最多设置 20 项，请减少标签');
  const tags = new Map<string, string>();
  for (const item of value) {
    const name = tagName(item);
    if (!tags.has(tagKey(name))) tags.set(tagKey(name), name);
  }
  return [...tags].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, name]) => name);
}
export function photoRating(value: unknown): number | null {
  if (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5)
  )
    return value;
  throw new PhotoLabelError('rating', '评分：请选择 1～5 星，或清除为未评分');
}
