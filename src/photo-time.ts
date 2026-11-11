export class PhotoTimeError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (field: string, message: string): never => {
  throw new PhotoTimeError(field, message);
};
const formatters = new Map<string, Intl.DateTimeFormat>();
export function photoTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100)
    return fail(
      'timeZone',
      '拍摄时区：请填写 IANA 时区（如 Asia/Shanghai）或 UTC 偏移（如 +08:00）',
    );
  const zone = value.trim();
  if (/^[+-]\d\d:\d\d$/.test(zone)) {
    const hour = Number(zone.slice(1, 3)),
      minute = Number(zone.slice(4));
    if (minute < 60 && hour <= 14 && (hour < 14 || minute === 0)) return zone;
  } else {
    try {
      return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      /* Report the field without echoing its submitted value. */
    }
  }
  return fail('timeZone', '拍摄时区：请填写有效 IANA 时区或 -14:00～+14:00 的 UTC 偏移');
}
function fixedOffset(zone: string): number | null {
  return /^[+-]\d\d:\d\d$/.test(zone)
    ? (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * 60000 * (zone[0] === '-' ? -1 : 1)
    : null;
}
export function localPhotoTime(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/.test(value)
  )
    return fail('dateTime', '拍摄时间：请填写完整的年月日、小时和分钟，可包含秒与毫秒');
  const [main, fraction = ''] = value.split('.');
  const normalized = (main!.length === 16 ? main + ':00' : main) + '.' + fraction.padEnd(3, '0');
  const epoch = Date.parse(normalized + 'Z');
  if (
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString() !== normalized + 'Z' ||
    normalized.startsWith('0000')
  )
    return fail('dateTime', '拍摄时间：日期或时间不存在，请核对年月日及 00:00～23:59 的时间');
  return normalized;
}
export function photoWallTime(instant: string, zone: string): string {
  const date = new Date(instant),
    offset = fixedOffset(zone);
  if (offset !== null) return new Date(date.getTime() + offset).toISOString().slice(0, -1);
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3, '0')}`;
}
export function resolvePhotoTime(
  value: unknown,
  rawZone: unknown,
  occurrence: 'earlier' | 'later' = 'earlier',
) {
  const local = localPhotoTime(value),
    zone = photoTimeZone(rawZone),
    epoch = Date.parse(local + 'Z');
  const fixed = fixedOffset(zone);
  const offsets = new Set<number>();
  if (fixed !== null) offsets.add(fixed);
  else
    for (let hours = -36; hours <= 36; hours += 6) {
      const probe = epoch + hours * 3600000;
      offsets.add(Date.parse(photoWallTime(new Date(probe).toISOString(), zone) + 'Z') - probe);
    }
  const candidates = [...offsets]
    .map((offset) => epoch - offset)
    .filter((time) => photoWallTime(new Date(time).toISOString(), zone) === local)
    .sort((a, b) => a - b);
  if (!candidates.length)
    return fail(
      'dateTime/timeZone',
      '拍摄时间、拍摄时区：该当地时间因时区或夏令时跳转而不存在，请选择有效时间',
    );
  const time = new Date(occurrence === 'later' ? candidates.at(-1)! : candidates[0]!).toISOString();
  if (!/^\d{4}-/.test(time) || time.startsWith('0000'))
    return fail('dateTime', '拍摄时间：转换后须在公元 1～9999 年范围内，请调整时间');
  return { time, zone, local, ambiguous: candidates.length > 1 };
}
