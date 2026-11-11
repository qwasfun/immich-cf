import { useEffect, useState } from 'react';
import { api, date, web } from './api';
import { Confirm, Empty, ErrorBox, Icon, Modal } from './ui';
import { sharePasswordError } from '../../src/web/share-password';

interface ShareLink {
  id: string;
  title: string;
  kind: 'album' | 'photos';
  photoCount: number | null;
  createdAt: string;
  expiresAt: string;
  passwordRequired: boolean;
  allowDownload: boolean;
}

type Permissions = { protected: boolean; password: string; allowDownload: boolean };

function permissionInput(value: Permissions, keepExisting = false) {
  const { protected: enabled, password, allowDownload } = value;
  if (!enabled) return { password: null, allowDownload };
  if (keepExisting && !password) return { allowDownload };
  const error = sharePasswordError(password);
  if (error) throw new Error(error);
  return { password, allowDownload };
}

function PermissionFields({
  value,
  change,
  busy,
  hasPassword = false,
}: {
  value: Permissions;
  change: (value: Permissions) => void;
  busy: boolean;
  hasPassword?: boolean;
}) {
  return (
    <>
      <label className="share-option">
        <input
          type="checkbox"
          checked={value.protected}
          disabled={busy}
          onChange={(event) => change({ ...value, protected: event.target.checked, password: '' })}
        />
        设置访问密码
      </label>
      {value.protected && (
        <label className="field">
          访问密码
          <input
            type="password"
            autoComplete="new-password"
            value={value.password}
            disabled={busy}
            onChange={(event) => change({ ...value, password: event.target.value })}
          />
          <small>
            {hasPassword
              ? '留空保留现有密码。更换后，访客需要重新解锁。'
              : '至少 8 个字符，UTF-8 编码后最多 72 字节。'}
          </small>
        </label>
      )}
      <label className="share-option">
        <input
          type="checkbox"
          checked={value.allowDownload}
          disabled={busy}
          onChange={(event) => change({ ...value, allowDownload: event.target.checked })}
        />
        允许下载原件
      </label>
    </>
  );
}

export function ShareDialog({
  ids,
  albumId,
  close,
}: ({ ids: string[]; albumId?: never } | { albumId: string; ids?: never }) & {
  close: () => void;
}) {
  const [days, setDays] = useState(7);
  const [link, setLink] = useState<(ShareLink & { path: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [permissions, setPermissions] = useState<Permissions>({
    protected: false,
    password: '',
    allowDownload: false,
  });
  const url = link ? window.location.origin + link.path : '';
  async function create() {
    setError('');
    setBusy(true);
    try {
      setLink(
        await api<ShareLink & { path: string }>(`${web}/shares`, 'POST', {
          days,
          ...(albumId ? { albumId } : { ids }),
          ...permissionInput(permissions),
        }),
      );
      setPermissions((value) => ({ ...value, password: '' }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={albumId ? '分享整本相册' : '分享所选照片'} close={close} busy={busy}>
      <div className="form-body">
        {link ? (
          <>
            <label className="field">
              分享链接
              <input value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
            </label>
            <p className="fine-print">
              请现在复制链接。关闭后仍可在「分享管理」撤销。有效至 {date(link.expiresAt)}。
            </p>
            {link.passwordRequired && <p className="muted">请将访问密码另行告诉访客。</p>}
            {copyMessage && <p role="status">{copyMessage}</p>}
          </>
        ) : (
          <>
            <p className="muted">
              {albumId
                ? '包含整本相册的照片，包括尚未加载和筛选隐藏的照片。以后添加或移除照片也会更新分享内容。'
                : `分享当前所选的 ${ids?.length ?? 0} 张照片。`}
            </p>
            <p className="notice">
              {permissions.protected
                ? '访客需要输入访问密码才能查看照片。'
                : '任何持有链接的人都可以免登录查看照片预览。'}
            </p>
            <label className="field">
              有效期
              <select
                disabled={busy}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={1}>1 天</option>
                <option value={7}>7 天</option>
                <option value={30}>30 天</option>
              </select>
            </label>
            <PermissionFields value={permissions} change={setPermissions} busy={busy} />
            <ErrorBox error={error} />
          </>
        )}
      </div>
      <footer className="modal-actions">
        <button onClick={close} disabled={busy}>
          {link ? '完成' : '取消'}
        </button>
        {link ? (
          <button
            className="primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopyMessage('链接已复制');
              } catch {
                setCopyMessage('请选中链接并手动复制');
              }
            }}
          >
            复制链接
          </button>
        ) : (
          <button className="primary" onClick={() => void create()} disabled={busy}>
            {busy ? '正在生成…' : '生成分享链接'}
          </button>
        )}
      </footer>
    </Modal>
  );
}

function EditShare({
  link,
  close,
  saved,
}: {
  link: ShareLink;
  close: () => void;
  saved: (link: ShareLink) => void;
}) {
  const [value, setValue] = useState<Permissions>({
    protected: link.passwordRequired,
    password: '',
    allowDownload: link.allowDownload,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      saved(
        await api<ShareLink>(
          `${web}/shares/${link.id}`,
          'PATCH',
          permissionInput(value, link.passwordRequired),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="编辑分享权限" close={close} busy={busy}>
      <div className="form-body">
        <p className="muted">{link.title}</p>
        <PermissionFields
          value={value}
          change={setValue}
          busy={busy}
          hasPassword={link.passwordRequired}
        />
        <ErrorBox error={error} />
      </div>
      <footer className="modal-actions">
        <button onClick={close} disabled={busy}>
          取消
        </button>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? '正在保存…' : '保存设置'}
        </button>
      </footer>
    </Modal>
  );
}

export function ManageShares({ refresh }: { refresh: number }) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [revoking, setRevoking] = useState<ShareLink | null>(null);
  const [editing, setEditing] = useState<ShareLink | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const control = new AbortController();
    setError('');
    api<{ items: ShareLink[] }>(`${web}/shares`, 'GET', undefined, control.signal)
      .then(({ items }) => {
        if (!control.signal.aborted) setLinks(items);
      })
      .catch((e: Error) => {
        if (!control.signal.aborted) setError(e.message);
      });
    return () => control.abort();
  }, [refresh, retry]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>分享管理</h1>
          <p className="muted">查看和撤销仍有效的分享链接。</p>
        </div>
      </div>
      <ErrorBox error={error} retry={() => setRetry((value) => value + 1)} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {links === null && !error && <p role="status">正在加载分享链接…</p>}
      {links?.length === 0 && (
        <Empty icon="link" title="暂无有效分享">
          可在照片选择栏或相册详情创建分享链接。
        </Empty>
      )}
      {links && links.length > 0 && (
        <ul className="panel share-list" aria-label="有效分享链接">
          {links.map((link) => (
            <li key={link.id}>
              <Icon name={link.kind === 'album' ? 'album' : 'photos'} />
              <div>
                <strong>{link.title}</strong>
                <small>
                  {link.kind === 'album' ? '整本相册' : `创建时选中 ${link.photoCount} 张照片`}
                </small>
                <small>
                  创建于 {date(link.createdAt)} · 有效至 {date(link.expiresAt)}
                </small>
                <small>
                  {link.passwordRequired ? '密码保护' : '无需密码'} ·{' '}
                  {link.allowDownload ? '可下载原件' : '仅预览'}
                </small>
              </div>
              <div className="share-list-actions">
                <button onClick={() => setEditing(link)}>编辑权限</button>
                <button onClick={() => setRevoking(link)}>撤销</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <EditShare
          link={editing}
          close={() => setEditing(null)}
          saved={(link) => {
            setLinks(
              (current) => current?.map((item) => (item.id === link.id ? link : item)) ?? null,
            );
            setEditing(null);
            setNotice('分享权限已保存');
          }}
        />
      )}
      {revoking && (
        <Confirm
          title="撤销分享链接"
          description={`撤销后，访客将无法再用此链接查看「${revoking.title}」。`}
          label="撤销链接"
          close={() => setRevoking(null)}
          action={() => api(`${web}/shares/${revoking.id}`, 'DELETE')}
          done={() => {
            setLinks((current) => current?.filter((link) => link.id !== revoking.id) ?? null);
            setRetry((value) => value + 1);
            setNotice('分享链接已撤销');
          }}
        />
      )}
    </>
  );
}
