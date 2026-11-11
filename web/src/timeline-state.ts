import { photoQuery, photoQueryParams, type PhotoQuery } from '../../src/web/gallery-query';

export interface TimelineAnchor {
  id: string;
  time: string;
  offset: number;
}
export interface TimelineSaved {
  query: PhotoQuery;
  anchor: TimelineAnchor | null;
}
const prefix = 'immich-cf-timeline:';
let currentAccount: string | null = null;
const memory = new Map<string, TimelineSaved>();

export function timelineAccount(owner: string | null) {
  if (currentAccount === owner && owner !== null) return;
  let sameStoredAccount = false;
  try {
    sameStoredAccount = owner !== null && sessionStorage.getItem(prefix + 'owner') === owner;
  } catch {
    /* Optional storage. */
  }
  currentAccount = owner;
  memory.clear();
  try {
    if (!sameStoredAccount)
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith(prefix)) sessionStorage.removeItem(key);
    if (owner) sessionStorage.setItem(prefix + 'owner', owner);
  } catch {
    /* Browsing also works when session storage is unavailable. */
  }
}
export function timelineEntry() {
  if (typeof window.history.state?.timelineEntry === 'string')
    return window.history.state.timelineEntry as string;
  const key = crypto.randomUUID();
  window.history.replaceState({ ...window.history.state, timelineEntry: key }, '');
  return key;
}
export function readTimeline(owner: string, entry: string, path: string): TimelineSaved | null {
  const key = prefix + owner + ':' + entry + ':' + path;
  const latest = prefix + owner + ':latest:' + path;
  try {
    let stored = null,
      storedLatest = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      storedLatest = JSON.parse(sessionStorage.getItem(latest) ?? 'null');
    } catch {
      /* Use the in-memory entries when storage is disabled. */
    }
    const saved = memory.get(key) ?? stored ?? memory.get(latest) ?? storedLatest;
    if (!saved || !saved.query || typeof saved.query !== 'object') return null;
    if (
      !['q', 'from', 'to', 'type', 'order'].every((name) => typeof saved.query[name] === 'string')
    )
      return null;
    const query = photoQuery(photoQueryParams(saved.query));
    const anchor = saved.anchor as TimelineAnchor | null;
    if (
      anchor &&
      (typeof anchor.id !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(anchor.id) ||
        typeof anchor.time !== 'string' ||
        !Number.isFinite(Date.parse(anchor.time)) ||
        !Number.isFinite(anchor.offset) ||
        Math.abs(anchor.offset) > 100000)
    )
      return null;
    return { query, anchor };
  } catch {
    return null;
  }
}
export function saveTimeline(owner: string, entry: string, path: string, saved: TimelineSaved) {
  if (currentAccount !== owner) return;
  const key = prefix + owner + ':' + entry + ':' + path;
  const latest = prefix + owner + ':latest:' + path;
  for (const target of [key, latest]) {
    memory.delete(target);
    memory.set(target, saved);
  }
  while (memory.size > 100) memory.delete(memory.keys().next().value!);
  try {
    sessionStorage.setItem(key, JSON.stringify(saved));
    sessionStorage.setItem(latest, JSON.stringify(saved));
    const keys = Object.keys(sessionStorage).filter(
      (item) => item.startsWith(prefix) && item !== prefix + 'owner',
    );
    for (const stale of keys.slice(0, Math.max(0, keys.length - 100)))
      sessionStorage.removeItem(stale);
  } catch {
    /* The bounded in-memory state still supports navigation. */
  }
}
