import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, date, web } from './api';
import type { Attachment } from './api';
import { Empty, ErrorBox, Logo, Preview } from './ui';
import { PhotoViewer } from './PhotoViewer';
import { sharePasswordError } from '../../src/web/share-password';

interface SharedPage {
  title: string;
  expiresAt: string;
  allowDownload: boolean;
  items: { id: string; hasMotion?: boolean }[];
  nextCursor: string | null;
}

const unavailable = '分享链接无效、已过期或已撤销，请向分享者索取新链接';

function Unlock({
  token,
  unlocked,
  expire,
}: {
  token: string;
  unlocked: (accessToken: string) => void;
  expire: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get('password');
    const invalid = sharePasswordError(password);
    setError(invalid);
    if (invalid || busy) return;
    setBusy(true);
    try {
      const access = await api<{ accessToken: string }>(
        `${web}/shared/unlock`,
        'POST',
        { password },
        undefined,
        false,
        token,
      );
      unlocked(access.accessToken);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) expire();
      else if (e instanceof ApiError && e.status === 409) unlocked('');
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel share-unlock" onSubmit={submit} noValidate>
      <h1>解锁照片分享</h1>
      <label className="field">
        访问密码
        <input name="password" type="password" autoComplete="current-password" disabled={busy} />
      </label>
      <ErrorBox error={error} />
      <button className="primary" disabled={busy}>
        {busy ? '正在验证…' : '解锁分享'}
      </button>
    </form>
  );
}

function SharedDownload({
  id,
  hasMotion,
  credential,
  lock,
}: {
  id: string;
  hasMotion: boolean;
  credential: string;
  lock: () => void;
}) {
  const current = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => () => current.current?.abort(), []);
  async function save(component: 'photo' | 'motion') {
    if (current.current) return;
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const file = await api<Attachment>(
        `${web}/shared/assets/${id}/download?component=${component}`,
        'GET',
        undefined,
        controller.signal,
        'attachment',
        credential,
      );
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(file.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setMessage('已交给浏览器保存');
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.status === 401) lock();
      else setError((e as Error).message);
    } finally {
      current.current = null;
      setBusy(false);
    }
  }
  return (
    <div className="share-download">
      <div className="share-list-actions">
        <button disabled={busy} onClick={() => void save('photo')}>
          {busy ? '正在下载…' : '下载照片原件'}
        </button>
        {hasMotion && (
          <button disabled={busy} onClick={() => void save('motion')}>
            下载动态原件
          </button>
        )}
        {busy && <button onClick={() => current.current?.abort()}>取消下载</button>}
      </div>
      {message && <p role="status">{message}</p>}
      <ErrorBox error={error} />
    </div>
  );
}

function SharedGallery({ token }: { token: string }) {
  const [page, setPage] = useState<SharedPage | null>(null);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<{ id: string; label: string } | null>(null);
  const [expired, setExpired] = useState(false);
  const [locked, setLocked] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const credential = accessToken ? token + '.' + accessToken : token;
  const more = useRef<{ control: AbortController; promise: Promise<SharedPage | null> } | null>(
    null,
  );
  const currentPage = useRef(page);
  currentPage.current = page;
  const moveEpoch = useRef(0);
  const lock = useCallback(() => {
    setPage(null);
    setOpen(null);
    setAccessToken('');
    setLocked(true);
  }, []);
  useEffect(() => {
    if (locked || expired) return;
    const control = new AbortController();
    moveEpoch.current++;
    more.current?.control.abort();
    more.current = null;
    setError('');
    setLoading(true);
    api<SharedPage>(`${web}/shared`, 'GET', undefined, control.signal, false, credential)
      .then((next) => {
        if (control.signal.aborted) return;
        setPage(next);
      })
      .catch((e: Error) => {
        if (control.signal.aborted) return;
        if (e instanceof ApiError && e.status === 404) setExpired(true);
        else if (e instanceof ApiError && e.status === 401) lock();
        else setError(e.message);
      })
      .finally(() => {
        if (!control.signal.aborted) setLoading(false);
      });
    return () => {
      control.abort();
      more.current?.control.abort();
      moveEpoch.current++;
    };
  }, [credential, retry, locked, expired, lock]);
  useEffect(() => {
    if (open && page && !page.items.some((item) => item.id === open.id)) setOpen(null);
  }, [page]);
  async function loadMore(): Promise<SharedPage | null> {
    if (more.current) return more.current.promise;
    const prior = currentPage.current;
    if (!prior?.nextCursor || loading) return null;
    const control = new AbortController();
    setLoading(true);
    setError('');
    const promise = (async () => {
      try {
        const next = await api<SharedPage>(
          `${web}/shared?cursor=${encodeURIComponent(prior.nextCursor!)}`,
          'GET',
          undefined,
          control.signal,
          false,
          credential,
        );
        if (control.signal.aborted) return null;
        const known = new Set(prior.items.map((item) => item.id)),
          combined = {
            ...next,
            items: [...prior.items, ...next.items.filter((item) => !known.has(item.id))],
          };
        currentPage.current = combined;
        setPage(combined);
        return combined;
      } catch (e) {
        if (!control.signal.aborted) {
          if (e instanceof ApiError && e.status === 404) setExpired(true);
          else if (e instanceof ApiError && e.status === 401) lock();
          else setError((e as Error).message);
        }
        return null;
      } finally {
        if (!control.signal.aborted) {
          more.current = null;
          setLoading(false);
        }
      }
    })();
    more.current = { control, promise };
    return promise;
  }
  async function moveOpen(direction: number) {
    if (!open || !currentPage.current || loading) return false;
    const epoch = ++moveEpoch.current,
      index = currentPage.current.items.findIndex((item) => item.id === open.id);
    const updated =
      index + direction >= currentPage.current.items.length
        ? await loadMore()
        : currentPage.current;
    if (epoch !== moveEpoch.current || !updated) return false;
    const candidate = updated.items[index + direction];
    if (!candidate) return false;
    setOpen({ id: candidate.id, label: `分享照片 ${index + direction + 1}` });
    return true;
  }
  function closeViewer() {
    moveEpoch.current++;
    setOpen(null);
  }
  function retryPage() {
    if (page?.nextCursor) void loadMore();
    else setRetry((value) => value + 1);
  }
  useEffect(() => {
    if (!page) return;
    const end = Date.parse(page.expiresAt);
    function check() {
      if (Date.now() >= end) setExpired(true);
    }
    const timer = window.setInterval(check, 30000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [page?.expiresAt]);
  if (expired)
    return (
      <Empty icon="link" title="分享已失效">
        {unavailable}
      </Empty>
    );
  if (locked)
    return (
      <Unlock
        token={token}
        expire={() => setExpired(true)}
        unlocked={(access) => {
          setAccessToken(access);
          setLocked(false);
        }}
      />
    );
  return (
    <>
      {page && (
        <>
          <div className="page-heading">
            <div>
              <h1>{page.title}</h1>
              <p className="muted">有效至 {date(page.expiresAt)}</p>
              {page.allowDownload && <p className="muted">打开照片可下载原件。</p>}
            </div>
          </div>
          {page.items.length === 0 && <Empty title="暂时没有可查看的照片" />}
          <div className="photo-grid">
            {page.items.map(({ id }, index) => {
              const label = `分享照片 ${index + 1}`;
              return (
                <article key={id} className="photo-tile">
                  <Preview id={id} name={label} shareToken={credential} onShareLocked={lock} />
                  <button
                    className="photo-open"
                    aria-label={`查看${label}`}
                    onClick={() => {
                      moveEpoch.current++;
                      setOpen({ id, label });
                    }}
                  />
                </article>
              );
            })}
          </div>
        </>
      )}
      <ErrorBox error={error} retry={retryPage} />
      {loading && <p role="status">正在加载分享照片…</p>}
      {page?.nextCursor && !error && (
        <div className="shared-load">
          <button disabled={loading} onClick={() => void loadMore()}>
            加载更多
          </button>
        </div>
      )}
      {open && (
        <PhotoViewer
          id={open.id}
          name={open.label}
          close={closeViewer}
          shareToken={credential}
          onShareLocked={lock}
          loading={loading}
          error={error}
          retry={retryPage}
          previous={
            page && page.items.findIndex((item) => item.id === open.id) > 0
              ? () => moveOpen(-1)
              : undefined
          }
          next={
            page &&
            (page.items.findIndex((item) => item.id === open.id) < page.items.length - 1 ||
              page.nextCursor)
              ? () => moveOpen(1)
              : undefined
          }
          actions={
            page?.allowDownload
              ? (act) => (
                  <div onClickCapture={() => act(() => undefined)}>
                    <SharedDownload
                      id={open.id}
                      hasMotion={page.items.some((item) => item.id === open.id && item.hasMotion)}
                      credential={credential}
                      lock={lock}
                    />
                  </div>
                )
              : undefined
          }
        />
      )}
    </>
  );
}

export function SharedPhotos() {
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    document.title = '照片分享 · Immich CF';
    const update = () => setToken(window.location.hash.slice(1));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return (
    <div className="shared-page">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>
            immich<span className="brand-cf"> cf</span>
          </span>
        </div>
      </header>
      <main>
        {/^[a-f0-9]{64}$/.test(token) ? (
          <SharedGallery key={token} token={token} />
        ) : (
          <Empty icon="link" title="分享链接不可用">
            {unavailable}
          </Empty>
        )}
      </main>
    </div>
  );
}
