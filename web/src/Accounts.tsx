import { useEffect, useRef, useState } from 'react';
import { api, bytes, date, web } from './api';
import type { Account, Bootstrap, Page } from './api';
import { Confirm, Empty, ErrorBox, FormModal, Icon } from './ui';

interface Session {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
}
export function MyAccount({
  boot,
  refresh,
  changed,
}: {
  boot: Bootstrap;
  refresh: number;
  changed: (m: string) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]),
    [error, setError] = useState(''),
    [password, setPassword] = useState(false),
    [target, setTarget] = useState<Session | null>(null);
  useEffect(() => {
    let active = true;
    setError('');
    api<Session[]>('/api/sessions')
      .then((rows) => {
        if (active) setSessions(rows);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR ACCOUNT</p>
          <h1>账号设置</h1>
          <p className="muted">管理你的账号、安全与登录会话。</p>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <h2>个人信息</h2>
          <div className="profile-row">
            <span className="avatar large-avatar">{boot.user.name.slice(0, 1)}</span>
            <div>
              <strong>{boot.user.name}</strong>
              <p className="muted">{boot.user.email}</p>
            </div>
          </div>
          <div className="usage-cards">
            <div>
              <strong>
                {boot.usage.logicalAssets.toLocaleString()}{' '}
                <small>/ {boot.limits.assetLimit.toLocaleString()}</small>
              </strong>
              <span>逻辑资产占用</span>
            </div>
            <div>
              <strong>{bytes(boot.usage.logicalBytes)}</strong>
              <span>原件逻辑大小</span>
            </div>
          </div>
          <p className="fine-print">
            逻辑资产名额含回收站与待完成上传；原件逻辑大小含回收站，不代表 R2 实际占用或账单。
          </p>
        </section>
        <section className="panel">
          <h2>密码与安全</h2>
          <p className="muted">定期更新密码，保护自己的照片。</p>
          <button onClick={() => setPassword(true)}>修改密码</button>
          <p className="fine-print">
            修改后，网页和 App 的全部会话都会退出，需要使用新密码重新登录。
          </p>
        </section>
      </div>
      <section className="panel session-panel">
        <div className="section-heading">
          <h2>登录会话</h2>
          <button onClick={() => changed('正在刷新会话')}>刷新</button>
        </div>
        <ErrorBox error={error} retry={() => changed('正在重新加载会话')} />
        {sessions.map((s) => (
          <div className="session-row" key={s.id}>
            <Icon name="shield" />
            <div>
              <strong>{s.current ? '当前会话' : '其他登录会话'}</strong>
              <p className="muted">
                创建于 {date(s.createdAt)} · 到期 {date(s.expiresAt)}
              </p>
            </div>
            <button onClick={() => setTarget(s)}>{s.current ? '退出此会话' : '撤销会话'}</button>
          </div>
        ))}
        <p className="fine-print">服务端尚未采集设备信息，因此按登录会话显示，不推断设备名称。</p>
      </section>
      {password && (
        <FormModal
          title="修改密码"
          close={() => setPassword(false)}
          fields={[
            { key: 'currentPassword', label: '旧密码', type: 'password' },
            {
              key: 'newPassword',
              label: '新密码',
              type: 'password',
              hint: '至少 15 个字符，UTF-8 编码后最多 72 字节',
            },
          ]}
          label="修改并退出全部会话"
          submit={async (values) => {
            await api(`${web}/password`, 'POST', values);
            window.dispatchEvent(
              new CustomEvent('session-expired', {
                detail: '密码已修改，网页和 App 均需使用新密码重新登录',
              }),
            );
          }}
        />
      )}
      {target && (
        <Confirm
          title="撤销登录会话？"
          description={
            target.current
              ? '将退出当前网页会话，之后需重新登录。'
              : '对应会话将不能继续读取照片或同步，需要重新登录。'
          }
          close={() => setTarget(null)}
          action={() => api(`/api/sessions/${target.id}`, 'DELETE')}
          done={() => {
            if (target.current)
              window.dispatchEvent(
                new CustomEvent('session-expired', { detail: '当前会话已退出，请重新登录' }),
              );
            else changed('会话已撤销');
          }}
        />
      )}
    </>
  );
}

export function AdminAccounts({
  refresh,
  changed,
}: {
  refresh: number;
  changed: (m: string) => void;
}) {
  const loadVersion = useRef(0);
  const [items, setItems] = useState<Account[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [dialog, setDialog] = useState(''),
    [target, setTarget] = useState<Account | null>(null);
  const base = '/api/immich-cf/admin/users';
  async function load(next?: string) {
    const version = ++loadVersion.current;
    setLoading(true);
    setError('');
    try {
      const rows = await api<Page<Account>>(
        `${base}?q=${encodeURIComponent(filter)}${next ? '&cursor=' + encodeURIComponent(next) : ''}`,
      );
      if (version !== loadVersion.current) return;
      setItems((prev) => (next ? [...prev, ...rows.items] : rows.items));
      setCursor(rows.nextCursor);
    } catch (e) {
      if (version === loadVersion.current) setError((e as Error).message);
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [refresh, filter]);
  function choose(kind: string, account: Account) {
    setTarget(account);
    setDialog(kind);
  }
  const close = () => setDialog('');
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ADMINISTRATION</p>
          <h1>账号管理</h1>
          <p className="muted">为家人创建账号，让每个人拥有自己的照片库。</p>
        </div>
        <button className="primary" onClick={() => setDialog('create')}>
          <Icon name="plus" />
          创建账号
        </button>
      </div>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter(query.trim());
        }}
      >
        <label className="sr-only" htmlFor="account-search">
          按邮箱或名称搜索账号
        </label>
        <input
          id="account-search"
          placeholder="搜索邮箱或显示名称"
          maxLength={80}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button>搜索</button>
      </form>
      <ErrorBox error={error} retry={() => void load()} />
      <div className="table-scroll">
        <table className="account-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>状态</th>
              <th>逻辑资产</th>
              <th>原件逻辑大小</th>
              <th>会话</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.name}</strong>
                  <span className="table-email">{u.email}</span>
                </td>
                <td>
                  <span className={`badge ${u.disabled ? 'disabled' : ''}`}>
                    {u.disabled ? '已停用' : u.isOperator ? '运维管理员' : '已启用'}
                  </span>
                </td>
                <td>
                  {u.logicalAssets.toLocaleString()} / {u.assetLimit.toLocaleString()}
                  <small className="table-email">回收站 {u.trashed} 张</small>
                </td>
                <td>{bytes(u.logicalBytes)}</td>
                <td>{u.sessions}</td>
                <td>
                  {u.isOperator ? (
                    <span className="fine-print">通过维护流程管理</span>
                  ) : (
                    <div className="row-actions">
                      <button onClick={() => choose('rename', u)}>改名</button>
                      <button onClick={() => choose('reset', u)}>重置密码</button>
                      <button onClick={() => choose('sessions', u)}>撤销会话</button>
                      <button
                        className={u.disabled ? '' : 'danger'}
                        onClick={() => choose('status', u)}
                      >
                        {u.disabled ? '启用' : '停用'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <p className="muted">正在加载账号…</p>}
      {!loading && !error && !items.length && (
        <Empty icon="users" title="没有找到账号">
          可以调整搜索条件，或创建一个新账号。
        </Empty>
      )}
      {cursor && (
        <div className="load-more">
          <button disabled={loading} onClick={() => void load(cursor)}>
            加载更多账号
          </button>
        </div>
      )}
      <p className="fine-print">
        名额包含回收站与待完成上传；原件逻辑大小不代表实际存储账单。网页只管理普通账号，不删除账号或授予管理员权限。
      </p>
      {dialog === 'create' && (
        <FormModal
          title="创建账号"
          label="创建账号"
          close={close}
          fields={[
            {
              key: 'email',
              label: '邮箱',
              type: 'email',
              hint: '作为登录名，创建后不能在网页修改',
            },
            { key: 'name', label: '显示名称' },
            {
              key: 'password',
              label: '初始密码',
              type: 'password',
              hint: '至少 15 个字符，UTF-8 编码后最多 72 字节。请通过私人渠道交给账号使用者。',
            },
          ]}
          submit={async (values) => {
            await api(base, 'POST', values);
            changed('账号已创建，用户可以登录网页或 App');
          }}
        />
      )}
      {dialog === 'rename' && target && (
        <FormModal
          title="修改显示名称"
          close={close}
          fields={[{ key: 'name', label: '显示名称', value: target.name }]}
          submit={async (values) => {
            await api(`${base}/${target.id}`, 'PATCH', values);
            changed('显示名称已修改');
          }}
        />
      )}
      {dialog === 'reset' && target && (
        <FormModal
          title={`重置密码 · ${target.name}`}
          label="重置并撤销全部会话"
          close={close}
          fields={[
            {
              key: 'password',
              label: '新密码',
              type: 'password',
              hint: '至少 15 个字符，UTF-8 编码后最多 72 字节',
            },
          ]}
          submit={async (values) => {
            await api(`${base}/${target.id}/reset-password`, 'POST', values);
            changed('密码已重置，对应账号的网页和 App 均需重新登录');
          }}
        >
          <p className="muted">重置后将立即撤销该账号全部会话，照片会保留。</p>
        </FormModal>
      )}
      {['status', 'sessions'].includes(dialog) && target && (
        <Confirm
          title={
            dialog === 'sessions' ? '撤销全部会话？' : target.disabled ? '启用账号？' : '停用账号？'
          }
          description={
            dialog === 'sessions'
              ? `“${target.name}”的网页和 App 会话均将退出，需要重新登录。`
              : target.disabled
                ? `启用“${target.name}”后，可重新登录并访问保留的照片。`
                : `“${target.name}”将立即失去访问权限并退出全部会话，照片与相册仍保留。`
          }
          danger={dialog === 'status' && !target.disabled}
          close={close}
          action={() =>
            dialog === 'sessions'
              ? api(`${base}/${target.id}/sessions`, 'DELETE')
              : api(`${base}/${target.id}`, 'PATCH', { disabled: !target.disabled })
          }
          done={() =>
            changed(
              dialog === 'sessions'
                ? '全部会话已撤销'
                : target.disabled
                  ? '账号已启用，请重新登录'
                  : '账号已停用，全部会话已撤销',
            )
          }
        />
      )}
    </>
  );
}
