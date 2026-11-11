export function sharePasswordError(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value).length < 8 ||
    new TextEncoder().encode(value).length > 72 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return '访问密码：请填写至少 8 个字符、UTF-8 编码后最多 72 字节且不含控制字符的密码';
  return '';
}
