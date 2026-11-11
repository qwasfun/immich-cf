import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, web, type Page, type Photo } from './api';
import { emptyPhotoQuery, photoQueryParams, type PhotoQuery } from '../../src/web/gallery-query';
import { readTimeline, saveTimeline, type TimelineAnchor } from './timeline-state';

export interface Month {
  key: string;
  year: number;
  month: number;
  count: number;
  anchorTime: string;
  anchorId: string;
}
type Overview = { version: string; months?: Month[]; unchanged?: boolean };
type Side = 'previous' | 'next';
type Position = TimelineAnchor;

export function useTimeline(
  view: string,
  albumId: string,
  refresh: number,
  owner: string,
  entry: string,
) {
  const enabled = view !== 'trash';
  const path = view + ':' + albumId;
  const [saved] = useState(() => (enabled ? readTimeline(owner, entry, path) : null));
  const [query, setQuery] = useState<PhotoQuery>(saved?.query ?? { ...emptyPhotoQuery });
  const [items, setItems] = useState<Photo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previousCursor, setPreviousCursor] = useState<string | null>(null);
  const [months, setMonths] = useState<Month[]>([]);
  const [activeMonth, setActiveMonth] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const before = useRef<HTMLDivElement>(null);
  const after = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const control = useRef(new AbortController());
  const restoring = useRef(true);
  const pendingPosition = useRef<Position | null>(null);
  const lastAnchor = useRef<TimelineAnchor | null>(saved?.anchor ?? null);
  const initialAnchor = useRef<TimelineAnchor | null>(saved?.anchor ?? null);
  const ignoreScrollUntil = useRef(0);
  const nodes = useRef<HTMLElement[]>([]);
  const pending = useRef<{ side: Side; promise: Promise<Photo[]> } | null>(null);
  const lastFailure = useRef<Side | null>(null);
  const scrollDirection = useRef<Side>('next');
  const userScrolled = useRef(false);
  const nearEdge = useRef({ previous: false, next: false });
  const state = useRef({
    items,
    cursor,
    previousCursor,
    months,
    query,
    loading,
    error,
    version: '',
  });
  state.current = {
    ...state.current,
    items,
    cursor,
    previousCursor,
    months,
    query,
    loading,
    error,
  };
  const latest = useRef({ replace, more, checkVersion });
  latest.current = { replace, more, checkVersion };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const queryKey = photoQueryParams(query).toString();
  const scope = `view=${view}&${queryKey}${albumId ? '&albumId=' + albumId : ''}`;
  const overviewPath = `${web}/timeline?${scope}&timeZone=${encodeURIComponent(timeZone)}`;

  function capture(): TimelineAnchor | null {
    const top =
      Number.parseFloat(root.current?.style.getPropertyValue('--timeline-top') ?? '') || 0;
    const cards = nodes.current;
    let low = 0,
      high = cards.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (cards[mid]!.getBoundingClientRect().bottom <= top + 36) low = mid + 1;
      else high = mid;
    }
    const card = cards[low];
    if (!card || card.getBoundingClientRect().top >= window.innerHeight) return null;
    return {
      id: card.dataset.photoId!,
      time: card.dataset.photoTime!,
      offset: card.getBoundingClientRect().top,
    };
  }
  function checkpoint() {
    if (!enabled) return;
    // Navigation can interrupt a month jump or restore before its request finishes.
    const anchor = restoring.current ? lastAnchor.current : (capture() ?? lastAnchor.current);
    lastAnchor.current = anchor;
    saveTimeline(owner, entry, path, { query: state.current.query, anchor });
  }
  function autoMore() {
    if (
      restoring.current ||
      !userScrolled.current ||
      state.current.loading ||
      state.current.error ||
      document.querySelector('dialog[open]')
    )
      return;
    const side = scrollDirection.current;
    if (nearEdge.current[side]) void latest.current.more(side);
  }
  async function replace(position: Position | null = null) {
    if (!enabled) position = null;
    const run = ++generation.current;
    control.current.abort();
    const controller = new AbortController();
    control.current = controller;
    pending.current = null;
    restoring.current = true;
    pendingPosition.current = null;
    lastAnchor.current = position;
    userScrolled.current = false;
    setLoading(true);
    setError('');
    lastFailure.current = null;
    const target = position
      ? `&anchorTime=${encodeURIComponent(position.time)}&anchorId=${position.id}`
      : '';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const [page, overview] = await Promise.all([
            api<Page<Photo>>(
              `${web}/assets?${scope}${target}`,
              'GET',
              undefined,
              controller.signal,
            ),
            enabled
              ? api<Overview>(overviewPath, 'GET', undefined, controller.signal)
              : Promise.resolve(null),
          ]);
          if (run !== generation.current || controller.signal.aborted) return;
          if (overview && overview.version !== page.version)
            throw new ApiError('照片列表：图库已变化，请重新定位后继续浏览', 409);
          state.current.version = page.version ?? '';
          initialAnchor.current = null;
          setItems(page.items);
          setCursor(page.nextCursor);
          setPreviousCursor(page.previousCursor ?? null);
          if (overview?.months) setMonths(overview.months);
          // Use the first returned photo when the old anchor has been removed.
          pendingPosition.current =
            position && page.items.length
              ? {
                  ...position,
                  id: page.items.some((p) => p.id === position.id)
                    ? position.id
                    : page.items[0]!.id,
                }
              : null;
          if (!pendingPosition.current) {
            restoring.current = false;
            lastAnchor.current = null;
          }
          return;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409 && attempt === 0)) throw e;
        }
      }
    } catch (e) {
      if (run === generation.current && !controller.signal.aborted) {
        setError((e as Error).message);
        restoring.current = false;
      }
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }
  async function more(side: Side): Promise<Photo[]> {
    if (restoring.current) return [];
    if (pending.current) {
      if (pending.current.side === side) return pending.current.promise;
      await pending.current.promise;
      return latest.current.more(side);
    }
    const next = side === 'previous' ? state.current.previousCursor : state.current.cursor;
    if (!next) return [];
    const run = generation.current;
    const position = side === 'previous' ? capture() : null;
    setLoading(true);
    setError('');
    lastFailure.current = side;
    const promise = (async () => {
      try {
        const page = await api<Page<Photo>>(
          `${web}/assets?${scope}&cursor=${encodeURIComponent(next)}`,
          'GET',
          undefined,
          control.current.signal,
        );
        if (run !== generation.current) return [];
        const known = new Set(state.current.items.map((p) => p.id));
        const added = page.items.filter((p) => !known.has(p.id));
        if (position && added.length) {
          restoring.current = true;
          pendingPosition.current = position;
        }
        setItems((current) =>
          side === 'previous' ? [...added, ...current] : [...current, ...added],
        );
        if (side === 'previous') setPreviousCursor(page.previousCursor ?? null);
        else setCursor(page.nextCursor);
        lastFailure.current = null;
        return added;
      } catch (e) {
        if (run !== generation.current || control.current.signal.aborted) return [];
        if (e instanceof ApiError && e.status === 409) {
          await latest.current.replace(capture() ?? lastAnchor.current);
        } else setError((e as Error).message);
        return [];
      } finally {
        if (run === generation.current) {
          pending.current = null;
          setLoading(false);
        }
      }
    })();
    pending.current = { side, promise };
    return promise;
  }
  async function checkVersion() {
    if (restoring.current || pending.current) return;
    if (!enabled) {
      await replace();
      return;
    }
    const run = generation.current;
    try {
      const overview = await api<Overview>(
        overviewPath + '&version=' + encodeURIComponent(state.current.version),
        'GET',
        undefined,
        control.current.signal,
      );
      if (run !== generation.current || overview.unchanged) return;
      await latest.current.replace(capture() ?? lastAnchor.current);
    } catch (e) {
      if (run === generation.current && !control.current.signal.aborted)
        setError((e as Error).message);
    }
  }
  useEffect(() => {
    const position = initialAnchor.current;
    void latest.current.replace(position);
    return () => {
      generation.current++;
      control.current.abort();
    };
  }, [view, albumId, queryKey, timeZone]);
  const previousRefresh = useRef(refresh);
  useEffect(() => {
    if (previousRefresh.current === refresh) return;
    previousRefresh.current = refresh;
    void latest.current.checkVersion();
  }, [refresh]);
  useLayoutEffect(() => {
    nodes.current = Array.from(
      root.current?.querySelectorAll<HTMLElement>('[data-photo-id]') ?? [],
    );
    const position = pendingPosition.current;
    if (!position) {
      const photo = capture() ?? (items[0] ? { time: items[0].fileCreatedAt } : null);
      if (photo) {
        const date = new Date(photo.time);
        setActiveMonth(
          `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`,
        );
      }
      return;
    }
    const card = nodes.current.find((node) => node.dataset.photoId === position.id);
    if (card) {
      ignoreScrollUntil.current = Date.now() + 100;
      window.scrollBy(0, card.getBoundingClientRect().top - position.offset);
      lastAnchor.current = {
        id: position.id,
        time: card.dataset.photoTime!,
        offset: position.offset,
      };
      const date = new Date(card.dataset.photoTime!);
      setActiveMonth(
        `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      );
    }
    pendingPosition.current = null;
    // Keep observers paused until the restored layout has reached the browser.
    const frame = requestAnimationFrame(() => {
      restoring.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [items]);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0,
      timer = 0,
      y = window.scrollY;
    const scroll = () => {
      const nextY = window.scrollY;
      if (!restoring.current && nextY !== y && Date.now() >= ignoreScrollUntil.current) {
        scrollDirection.current = nextY < y ? 'previous' : 'next';
        userScrolled.current = true;
      }
      y = nextY;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (restoring.current) return;
        const anchor = capture();
        if (anchor) {
          lastAnchor.current = anchor;
          const date = new Date(anchor.time);
          setActiveMonth(
            `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`,
          );
        }
        clearTimeout(timer);
        timer = window.setTimeout(checkpoint, 150);
        autoMore();
      });
    };
    window.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('timeline-checkpoint', checkpoint);
    window.addEventListener('pagehide', checkpoint);
    return () => {
      checkpoint();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('timeline-checkpoint', checkpoint);
      window.removeEventListener('pagehide', checkpoint);
    };
  }, [enabled, owner, entry, path]);
  useEffect(() => {
    if (!enabled || loading || error) return;
    nearEdge.current = { previous: false, next: false };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const item of entries) {
          const side = item.target === before.current ? 'previous' : 'next';
          nearEdge.current[side] = item.isIntersecting;
        }
        autoMore();
      },
      { rootMargin: '300px' },
    );
    if (previousCursor && before.current) observer.observe(before.current);
    if (cursor && after.current) observer.observe(after.current);
    return () => observer.disconnect();
  }, [enabled, loading, error, cursor, previousCursor, items]);

  function apply(next: PhotoQuery) {
    restoring.current = true;
    initialAnchor.current = null;
    lastAnchor.current = null;
    nodes.current = [];
    state.current.version = '';
    setItems([]);
    setCursor(null);
    setPreviousCursor(null);
    setMonths([]);
    saveTimeline(owner, entry, path, { query: next, anchor: null });
    if (photoQueryParams(next).toString() === queryKey) void replace();
    setQuery(next);
    window.scrollTo(0, 0);
  }
  function jump(month: Month) {
    const top =
      Number.parseFloat(root.current?.style.getPropertyValue('--timeline-top') ?? '') || 0;
    setActiveMonth(month.key);
    void replace({ id: month.anchorId, time: month.anchorTime, offset: top + 44 });
  }
  function retry() {
    if (lastFailure.current) void more(lastFailure.current);
    else void replace(capture() ?? lastAnchor.current);
  }
  function restoreAnchor(anchor: TimelineAnchor | null) {
    if (!anchor) return;
    const run = generation.current;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (generation.current !== run) return;
        const card = nodes.current.find((node) => node.dataset.photoId === anchor.id);
        if (!card) return;
        ignoreScrollUntil.current = Date.now() + 100;
        window.scrollBy(0, card.getBoundingClientRect().top - anchor.offset);
        lastAnchor.current = anchor;
      }),
    );
  }
  return {
    enabled,
    version: state.current.version,
    root,
    before,
    after,
    items,
    query,
    apply,
    cursor,
    previousCursor,
    months,
    activeMonth,
    loading,
    error,
    setError,
    more,
    jump,
    retry,
    captureAnchor: capture,
    restoreAnchor,
  };
}
