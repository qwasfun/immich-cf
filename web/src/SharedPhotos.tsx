import { useEffect, useState } from 'react';
import { api, ApiError, date, web } from './api';
import { Empty, ErrorBox, Logo, Modal, Preview } from './ui';

interface SharedPage {
  title: string;
  expiresAt: string;
  items: { id: string }[];
  nextCursor: string | null;
}

const unavailable = '分享链接无效、已过期或已撤销，请向分享者索取新链接';

function SharedGallery({ token }: { token: string }) {
  const [page, setPage] = useState<SharedPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<{ id: string; label: string } | null>(null);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const control = new AbortController();
    setError('');
    setLoading(true);
    api<SharedPage>(
      `${web}/shared${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
      'GET',
      undefined,
      control.signal,
      false,
      token,
    )
      .then((next) => {
        if (control.signal.aborted) return;
        setPage((previous) =>
          cursor && previous ? { ...next, items: [...previous.items, ...next.items] } : next,
        );
      })
      .catch((e: Error) => {
        if (control.signal.aborted) return;
        if (e instanceof ApiError && e.status === 404) setExpired(true);
        else setError(e.message);
      })
      .finally(() => {
        if (!control.signal.aborted) setLoading(false);
      });
    return () => control.abort();
  }, [token, cursor, retry]);
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
  return (
    <>
      {page && (
        <>
          <div className="page-heading">
            <div>
              <h1>{page.title}</h1>
              <p className="muted">有效至 {date(page.expiresAt)}</p>
            </div>
          </div>
          {page.items.length === 0 && <Empty title="暂时没有可查看的照片" />}
          <div className="photo-grid">
            {page.items.map(({ id }, index) => {
              const label = `分享照片 ${index + 1}`;
              return (
                <article key={id} className="photo-tile">
                  <Preview id={id} name={label} shareToken={token} />
                  <button
                    className="photo-open"
                    aria-label={`查看${label}`}
                    onClick={() => setOpen({ id, label })}
                  />
                </article>
              );
            })}
          </div>
        </>
      )}
      <ErrorBox error={error} retry={() => setRetry((value) => value + 1)} />
      {loading && <p role="status">正在加载分享照片…</p>}
      {page?.nextCursor && !error && (
        <div className="shared-load">
          <button disabled={loading} onClick={() => setCursor(page.nextCursor)}>
            加载更多
          </button>
        </div>
      )}
      {open && (
        <Modal title={open.label} close={() => setOpen(null)} wide>
          <div className="viewer-body shared-viewer">
            <div className="viewer-stage">
              <Preview id={open.id} name={open.label} shareToken={token} large />
            </div>
          </div>
        </Modal>
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
