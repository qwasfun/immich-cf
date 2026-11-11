import { photoTimeZone, photoWallTime } from './photo-time';

export class MemoryDateError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}

export function memoryDate(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000')) {
    const time = Date.parse(value + 'T00:00:00.000Z');
    if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value) return value;
  }
  throw new MemoryDateError('memoryDate', '回忆日期：请填写公元 1～9999 年内有效的年月日');
}

export function memoryContext(params: URLSearchParams, now = new Date()) {
  const timeZone = photoTimeZone(params.get('timeZone') ?? 'UTC');
  const today = photoWallTime(now.toISOString(), timeZone).slice(0, 10);
  const date = memoryDate(params.get('memoryDate') ?? today);
  if (date > today)
    throw new MemoryDateError('memoryDate', '回忆日期：不能晚于当地今天，请选择今天或之前的日期');
  return { date, timeZone, year: Number(date.slice(0, 4)) };
}

// Find actual instants belonging to a civil day rather than assuming it lasts 24 hours.
// Hourly probes also cover midnight transitions and a wholly skipped calendar date.
export function memoryDayRanges(date: string, timeZone: string) {
  const midnight = Date.parse(memoryDate(date) + 'T00:00:00.000Z');
  const minimum = Date.parse('0001-01-01T00:00:00.000Z');
  const maximum = Date.parse('9999-12-31T23:59:59.999Z') + 1;
  const start = Math.max(minimum, midnight - 36 * 3600000);
  const end = Math.min(maximum, midnight + 60 * 3600000);
  const belongs = (time: number) =>
    time < maximum && photoWallTime(new Date(time).toISOString(), timeZone).slice(0, 10) === date;
  const ranges: { from: string; to: string }[] = [];
  let was = belongs(start),
    opened = was ? start : null;
  for (let previous = start; previous < end;) {
    const next = Math.min(end, previous + 3600000),
      is = belongs(next);
    if (is !== was) {
      let low = previous,
        high = next;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (belongs(middle) === was) low = middle;
        else high = middle;
      }
      if (is) opened = high;
      else if (opened !== null) {
        ranges.push({ from: new Date(opened).toISOString(), to: new Date(high).toISOString() });
        opened = null;
      }
    }
    was = is;
    previous = next;
  }
  if (opened !== null)
    ranges.push({ from: new Date(opened).toISOString(), to: new Date(end).toISOString() });
  return ranges;
}
