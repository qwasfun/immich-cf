import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, bytes, web } from './api';
import type { Bootstrap } from './api';
import { Albums, Gallery } from './Gallery';
import { AdminAccounts, MyAccount } from './Accounts';
import { ErrorBox, Icon, Logo } from './ui';

function Login({ loggedIn, message }: { loggedIn: () => void; message: string }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget));
    if (!values.email || !String(values.email).trim()) {
      setError('邮箱：不能为空，请填写登录邮箱');
      return;
    }
    if (!values.password) {
      setError('密码：不能为空，请填写密码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', 'POST', values);
      loggedIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-story">
        <a className="brand" href="/">
          <Logo />
          <span>
            immich<span className="brand-cf"> cf</span>
          </span>
        </a>
        <div className="story-copy">
          <span className="story-eyebrow">A HOME FOR YOUR MEMORIES</span>
          <h1>
            每一个瞬间，
            <br />
            都值得留在身边。
          </h1>
          <p>
            属于你的私人照片库。
            <br />
            收藏日常，也珍藏那些特别的时刻。
          </p>
        </div>
        <div className="landscape" aria-hidden="true">
          <div className="sun" />
          <div className="hill far" />
          <div className="hill near" />
          <div className="landscape-caption">YOUR MOMENTS. YOUR SPACE.</div>
        </div>
        <p className="story-footer">照片与回忆，自在收藏。</p>
      </section>
      <section className="login-form-side">
        <form className="login-form" onSubmit={submit} noValidate>
          <span className="login-icon">
            <Icon name="photos" size={28} />
          </span>
          <p className="eyebrow">WELCOME BACK</p>
          <h2>回到你的照片库</h2>
          <p className="muted">使用现有 Immich 账号登录</p>
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          <label className="field" htmlFor="login-email">
            邮箱
            <input
              id="login-email"
              name="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="username"
              disabled={busy}
            />
          </label>
          <label className="field" htmlFor="login-password">
            密码
            <input
              id="login-password"
              name="password"
              type="password"
              placeholder="输入密码"
              autoComplete="current-password"
              disabled={busy}
            />
          </label>
          <ErrorBox error={error} />
          <button className="primary login-submit" disabled={busy}>
            {busy ? '正在登录…' : '登录照片库'}
            <Icon name="right" size={18} />
          </button>
          <p className="login-help">账号由管理员创建。忘记密码时，请联系管理员重置。</p>
        </form>
        <p className="login-footnote">IMMICH CF · PRIVATE PHOTO LIBRARY</p>
      </section>
    </div>
  );
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [path, setPath] = useState(window.location.pathname),
    [refresh, setRefresh] = useState(0),
    [mobile, setMobile] = useState(false);
  function navigate(next: string) {
    window.history.pushState({}, '', next);
    setPath(next);
    setMobile(false);
    setMessage('');
    window.scrollTo({ top: 0 });
  }
  async function initialize() {
    setError('');
    try {
      const value = await api<Bootstrap>(`${web}/bootstrap`);
      setBoot(value);
      if (window.location.pathname === '/' || window.location.pathname === '/login') {
        window.history.replaceState({}, '', '/photos');
        setPath('/photos');
      }
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message);
    } finally {
      setReady(true);
    }
  }
  useEffect(() => {
    void initialize();
    const expired = (e: Event) => {
      setBoot(null);
      setReady(true);
      setMessage((e as CustomEvent<string>).detail || '会话已失效，请重新登录');
      window.history.replaceState({}, '', '/login');
      setPath('/login');
    };
    const pop = () => {
      setPath(window.location.pathname);
      setMobile(false);
    };
    window.addEventListener('session-expired', expired);
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('session-expired', expired);
      window.removeEventListener('popstate', pop);
    };
  }, []);
  useEffect(() => {
    if (!boot) return;
    const listener = () => {
      if (document.visibilityState === 'visible') {
        setRefresh((v) => v + 1);
        void initialize();
      }
    };
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, [!!boot]);
  useEffect(() => {
    document.title = `${path.startsWith('/albums') ? '相册' : path === '/favorites' ? '收藏' : path === '/trash' ? '回收站' : path === '/account' ? '账号设置' : path === '/admin/users' ? '账号管理' : '我的照片'} · Immich CF`;
  }, [path]);
  function changed(text: string) {
    setMessage(text);
    setRefresh((v) => v + 1);
    void initialize();
  }
  if (!ready)
    return (
      <div className="app-loading">
        <Logo />
        <p>正在打开照片库…</p>
      </div>
    );
  if (!boot)
    return (
      <>
        {error && (
          <div className="startup-error">
            <ErrorBox error={error} retry={() => void initialize()} />
          </div>
        )}
        <Login
          message={message}
          loggedIn={() => {
            setMessage('');
            void initialize();
          }}
        />
      </>
    );
  const entries = [
    { path: '/photos', label: '照片', icon: 'photos' },
    { path: '/favorites', label: '收藏', icon: 'heart' },
    { path: '/albums', label: '相册', icon: 'album' },
    { path: '/trash', label: '回收站', icon: 'trash' },
  ];
  const albumId = /^\/albums\/([a-f0-9-]{36})$/.exec(path)?.[1];
  return (
    <div className="app-shell">
      {mobile && (
        <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobile(false)} />
      )}
      <aside className={`sidebar ${mobile ? 'expanded' : ''}`}>
        <a
          href="/photos"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate('/photos');
          }}
        >
          <Logo />
          <span>
            immich<span className="brand-cf"> cf</span>
          </span>
        </a>
        <p className="nav-label">我的照片库</p>
        <nav aria-label="主要导航">
          {entries.map((e) => (
            <a
              key={e.path}
              href={e.path}
              className={path === e.path || (e.path === '/albums' && albumId) ? 'active' : ''}
              onClick={(event) => {
                event.preventDefault();
                navigate(e.path);
              }}
            >
              <Icon name={e.icon} />
              {e.label}
              {e.path === '/trash' && boot.usage.trashed > 0 && (
                <span className="nav-count">{boot.usage.trashed}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-summary">
            <Icon name="shield" size={17} />
            <span>私人照片库</span>
            <strong>
              {boot.usage.logicalAssets.toLocaleString()} /{' '}
              {boot.limits.assetLimit.toLocaleString()}
            </strong>
            <div className="usage-track">
              <span
                style={{
                  width: `${Math.min(100, (boot.usage.logicalAssets / boot.limits.assetLimit) * 100)}%`,
                }}
              />
            </div>
            <small>{bytes(boot.usage.logicalBytes)} 原件逻辑大小</small>
          </div>
          {boot.canManageAccounts && (
            <a
              href="/admin/users"
              className={path === '/admin/users' ? 'sidebar-link active' : 'sidebar-link'}
              onClick={(e) => {
                e.preventDefault();
                navigate('/admin/users');
              }}
            >
              <Icon name="users" />
              账号管理
            </a>
          )}
          <a
            className={`account-link ${path === '/account' ? 'active' : ''}`}
            href="/account"
            onClick={(e) => {
              e.preventDefault();
              navigate('/account');
            }}
          >
            <span className="avatar">{boot.user.name.slice(0, 1)}</span>
            <span>
              <strong>{boot.user.name}</strong>
              <small>账号设置</small>
            </span>
            <Icon name="right" size={16} />
          </a>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobile((v) => !v)}
            >
              <Icon name="menu" />
            </button>
            <span className="topbar-label">留住每一刻</span>
            <span className="private-label">
              <Icon name="shield" size={13} />
              私人图库
            </span>
          </div>
          <div>
            <button aria-label="刷新照片库" onClick={() => changed('已请求刷新')}>
              <Icon name="refresh" size={17} />
              <span>刷新</span>
            </button>
            <button
              className="icon-button"
              aria-label="退出登录"
              title="退出登录"
              onClick={async () => {
                try {
                  await api('/api/auth/logout', 'POST');
                  setBoot(null);
                  setMessage('已退出登录');
                  navigate('/login');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <Icon name="logout" size={19} />
            </button>
          </div>
        </header>
        <main>
          <ErrorBox error={error} retry={() => void initialize()} />
          {message && (
            <div className="notice" role="status">
              <Icon name="check" size={17} />
              <span>{message}</span>
              <button className="icon-button" aria-label="关闭提示" onClick={() => setMessage('')}>
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          {path === '/albums' ? (
            <Albums refresh={refresh} changed={changed} navigate={navigate} />
          ) : path === '/account' ? (
            <MyAccount boot={boot} refresh={refresh} changed={changed} />
          ) : path === '/admin/users' ? (
            boot.canManageAccounts ? (
              <AdminAccounts refresh={refresh} changed={changed} />
            ) : (
              <ErrorBox error="管理员权限：当前账号无权管理其他账号" />
            )
          ) : ['/photos', '/favorites', '/trash'].includes(path) || albumId ? (
            <Gallery
              key={path}
              view={albumId ? 'album' : path.slice(1)}
              albumId={albumId}
              refresh={refresh}
              changed={changed}
            />
          ) : (
            <div className="empty">
              <h1>页面不存在</h1>
              <button onClick={() => navigate('/photos')}>返回照片库</button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
