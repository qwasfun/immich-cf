import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, web } from './api';

const shapes: Record<string, ReactNode> = {
  photos: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m3 17 6-6 4 4 3-3 5 5" />
    </>
  ),
  heart: (
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
  ),
  album: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2Zm0 12h16" />
      <path d="M9 7h6m-3 3v4m-2-2h4" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v6m4-6v6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M2 21v-3a7 7 0 0 1 14 0v3m0-16a3 3 0 0 1 0 6m3 3a6 6 0 0 1 3 5v2" />
    </>
  ),
  plus: <path d="M12 4v16M4 12h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  left: <path d="m15 5-7 7 7 7" />,
  right: <path d="m9 5 7 7-7 7" />,
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H4v16h5m5-13 5 5-5 5m-6-5h12" />
    </>
  ),
  play: <path d="m8 4 13 8-13 8Z" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  shield: (
    <>
      <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name] ?? shapes.photos}
    </svg>
  );
}
export function Logo() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return error ? (
    <div className="error-box" role="alert">
      <Icon name="info" />
      <span>{error}</span>
      {retry && <button onClick={retry}>重试</button>}
    </div>
  ) : null;
}
export function Empty({
  icon = 'photos',
  title,
  children,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={34} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Modal({
  title,
  close,
  children,
  wide = false,
  busy = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="modal-inner">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" disabled={busy} onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
export interface Field {
  key: string;
  label: string;
  type?: string;
  value?: string;
  optional?: boolean;
  hint?: string;
}
export function FormModal({
  title,
  fields,
  submit,
  close,
  label = '保存',
  children,
}: {
  title: string;
  fields: Field[];
  submit: (values: Record<string, string>) => Promise<void>;
  close: () => void;
  label?: string;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    for (const f of fields)
      if (!f.optional && !data[f.key]?.trim()) {
        setError(`${f.label}：不能为空，请填写${f.label}`);
        return;
      }
    setBusy(true);
    setError('');
    try {
      await submit(data);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={title} close={close} busy={busy}>
      <form onSubmit={send} noValidate>
        <div className="form-body">
          {children}
          {fields.map((f) => (
            <label className="field" key={f.key}>
              {f.label}
              <input
                name={f.key}
                type={f.type ?? 'text'}
                defaultValue={f.value ?? ''}
                autoComplete={
                  f.type === 'password'
                    ? f.key === 'currentPassword'
                      ? 'current-password'
                      : 'new-password'
                    : f.type === 'email'
                      ? 'email'
                      : 'off'
                }
                disabled={busy}
                maxLength={f.key === 'name' ? 80 : undefined}
              />
              {f.hint && <small>{f.hint}</small>}
            </label>
          ))}
          <ErrorBox error={error} />
        </div>
        <footer className="modal-actions">
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '正在保存…' : label}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function Confirm({
  title,
  description,
  action,
  close,
  done,
  danger = false,
  label = '确定',
}: {
  title: string;
  description: string;
  action: () => Promise<unknown>;
  close: () => void;
  done: (result: unknown) => void;
  danger?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title={title} close={close} busy={busy}>
      <div className="form-body">
        <p className="confirm-description">{description}</p>
        <ErrorBox error={error} />
      </div>
      <footer className="modal-actions">
        <button onClick={close} disabled={busy}>
          取消
        </button>
        <button
          className={danger ? 'danger solid' : 'primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await action();
              done(result);
              close();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '正在处理…' : label}
        </button>
      </footer>
    </Modal>
  );
}

// Only visible images fetch derivatives. At most four image requests run concurrently.
let active = 0;
const waiters: (() => void)[] = [];
async function imageTask<T>(task: () => Promise<T>) {
  if (active >= 4) await new Promise<void>((resolve) => waiters.push(resolve));
  else active++;
  try {
    return await task();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }
}
export function Preview({
  id,
  large = false,
  name = '',
}: {
  id: string;
  large?: boolean;
  name?: string;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [visible, setVisible] = useState(large),
    [attempt, setAttempt] = useState(0),
    [src, setSrc] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    if (visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '180px' },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let objectUrl = '';
    setSrc('');
    setError('');
    imageTask(async () => {
      if (controller.signal.aborted) return;
      for (let retry = 0; retry < 4; retry++) {
        try {
          const blob = await api<Blob>(
            `${web}/assets/${id}/preview?size=${large ? 'preview' : 'thumbnail'}`,
            'GET',
            undefined,
            controller.signal,
            true,
          );
          if (!controller.signal.aborted) {
            objectUrl = URL.createObjectURL(blob);
            setSrc(objectUrl);
          }
          return;
        } catch (e) {
          if (controller.signal.aborted) return;
          if (
            retry === 3 ||
            (e as { status?: number }).status !== 503 ||
            (e as Error).message.includes('额度')
          )
            throw e;
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, 2000 * (retry + 1));
            controller.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          if (controller.signal.aborted) return;
        }
      }
    }).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, large, visible, attempt]);
  return (
    <div ref={ref} className={`preview ${large ? 'large' : ''}`}>
      {src ? (
        <img
          src={src}
          alt={name}
          onError={() => {
            setSrc('');
            setError('预览图片无法显示，请重试或下载原件');
          }}
        />
      ) : error ? (
        <div className="preview-error">
          <Icon name="photos" size={large ? 34 : 22} />
          <span>{error.replace(/^preview[：:]/, '')}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAttempt((a) => a + 1);
            }}
          >
            重试预览
          </button>
        </div>
      ) : (
        <div className="preview-loading">
          <span className="spinner" />
          <span className="sr-only">正在加载预览</span>
        </div>
      )}
    </div>
  );
}
