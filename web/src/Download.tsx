import { useEffect, useId, useRef, useState } from 'react';
import { api, bytes, web } from './api';
import { ErrorBox, Icon, Modal } from './ui';

interface Part {
  id: string;
  filename: string;
  photos: number;
  files: number;
  bytes: number;
  state: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  completedFiles: number;
  completedBytes: number;
  error: string;
  runId: string | null;
  expiresAt: string;
}
interface Plan {
  title: string;
  photos: number;
  files: number;
  bytes: number;
  parts: Part[];
}
function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('已停止', 'AbortError'));
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException('已停止', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 1500);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export function Download({
  ids,
  albumId,
  close,
}: {
  ids?: string[];
  albumId?: string;
  close: () => void;
}) {
  const frameName = 'download-' + useId(),
    abort = useRef<AbortController | null>(null),
    mounted = useRef(true),
    locked = useRef(false),
    keepGoing = useRef(true);
  const [plan, setPlan] = useState<Plan | null>(null),
    [error, setError] = useState(''),
    [preparing, setPreparing] = useState(true),
    [active, setActive] = useState<string | null>(null),
    [stopRequested, setStopRequested] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    mounted.current = true;
    const control = new AbortController();
    abort.current = control;
    setPreparing(true);
    setError('');
    setPlan(null);
    api<Plan>(`${web}/downloads`, 'POST', albumId ? { albumId } : { ids }, control.signal)
      .then((value) => {
        if (mounted.current) {
          if (!value.parts?.length) throw new Error('下载计划：没有可用分包，请重新准备');
          setPlan(value);
        }
      })
      .catch((error) => {
        if (mounted.current && !control.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (mounted.current && !control.signal.aborted) setPreparing(false);
      });
    return () => {
      mounted.current = false;
      keepGoing.current = false;
      control.abort();
      abort.current?.abort();
    };
  }, [ids, albumId, reload]);
  function update(part: Part) {
    setPlan((previous) =>
      previous
        ? { ...previous, parts: previous.parts.map((row) => (row.id === part.id ? part : row)) }
        : previous,
    );
  }
  async function download(parts: Part[]) {
    if (locked.current || !parts.length) return;
    locked.current = true;
    keepGoing.current = true;
    setStopRequested(false);
    setError('');
    const control = new AbortController();
    abort.current = control;
    try {
      for (const part of parts) {
        if (!mounted.current || !keepGoing.current) break;
        if (!/^[a-f0-9-]{36}$/i.test(part.id)) throw new Error('下载任务：标识无效，请重新准备');
        const attempt = crypto.randomUUID(),
          started = Date.now();
        setActive(part.id);
        update({
          ...part,
          state: 'queued',
          completedFiles: 0,
          completedBytes: 0,
          error: '',
          runId: attempt,
        });
        const link = document.createElement('a');
        link.href = `${web}/downloads/${part.id}/archive?attempt=${attempt}`;
        link.download = part.filename;
        link.target = frameName;
        document.body.append(link);
        link.click();
        link.remove();
        while (mounted.current) {
          await wait(control.signal);
          const state = await api<Part>(
            `${web}/downloads/${part.id}`,
            'GET',
            undefined,
            control.signal,
          );
          if (state.runId !== attempt) {
            if (Date.now() - started > 30000)
              throw new Error('下载尚未开始：请在浏览器中允许文件下载，再点击该分包重试');
            continue;
          }
          update(state);
          if (state.state === 'complete') break;
          if (state.state === 'failed' || state.state === 'cancelled')
            throw new Error(state.error || '下载传输未完成，请重新下载该分包');
        }
      }
    } catch (error) {
      if (mounted.current && !control.signal.aborted) setError((error as Error).message);
    } finally {
      locked.current = false;
      if (mounted.current) setActive(null);
    }
  }
  return (
    <Modal title={albumId ? '下载整本相册' : '下载所选照片'} close={close} wide>
      <div className="form-body download-body">
        <p className="muted">
          {albumId
            ? '包含整本相册中尚未加载、被筛选隐藏的照片，不包含已移入回收站的项目。'
            : `打包当前所选的 ${ids?.length ?? 0} 张照片。`}
          Live Photo 将同时包含照片和 MOV 原件。
        </p>
        {preparing && (
          <p className="download-wait" role="status">
            <span className="spinner" />
            正在确认原件清单并准备分包…
          </p>
        )}
        <ErrorBox error={error} />
        {error && plan && !active && (
          <button onClick={() => setReload((value) => value + 1)}>重新准备下载</button>
        )}
        {!preparing && !plan && (
          <button onClick={() => setReload((value) => value + 1)}>重新准备下载</button>
        )}
        {plan && (
          <>
            <div className="download-overview">
              <strong>{plan.title}</strong>
              <span>
                {plan.photos.toLocaleString()} 张照片 · {plan.files.toLocaleString()} 份原件 ·{' '}
                {bytes(plan.bytes)}
              </span>
            </div>
            {plan.parts.length > 1 && (
              <div className="notice" role="status">
                将分成 {plan.parts.length} 个 ZIP，每包最多 1 GiB 原件或 1000
                份文件，同一组动态照片不会拆开。可依次下载全部，也可逐包下载。
              </div>
            )}
            <ol className="download-parts" aria-label="ZIP 下载分包">
              {plan.parts.map((part, index) => (
                <li key={part.id}>
                  <Icon name="download" size={22} />
                  <div className="download-part-info">
                    <strong>{part.filename}</strong>
                    <span>
                      第 {index + 1} / {plan.parts.length} 包 · {part.photos} 张照片 · {part.files}{' '}
                      份原件 · {bytes(part.bytes)}
                    </span>
                    {active === part.id && (
                      <>
                        <progress
                          max={Math.max(1, part.bytes)}
                          value={part.completedBytes}
                          aria-label={`${part.filename} 打包进度`}
                        />
                        <small role="status">
                          {part.state === 'queued'
                            ? '等待浏览器开始下载…'
                            : `正在传输 · 已处理 ${part.completedFiles} / ${part.files} 份原件`}
                        </small>
                      </>
                    )}
                    {part.state === 'complete' && (
                      <small className="download-complete">
                        服务端传输完成，请在浏览器下载列表确认文件已保存
                      </small>
                    )}
                    {part.error && <small className="upload-item-error">{part.error}</small>}
                  </div>
                  <button disabled={!!active} onClick={() => void download([part])}>
                    {part.state === 'complete'
                      ? '再次下载'
                      : part.state === 'failed'
                        ? '重试'
                        : '下载 ZIP'}
                  </button>
                </li>
              ))}
            </ol>
            <p className="fine-print">
              下载任务保留 24
              小时，并绑定当前登录。关闭面板会停止后续分包，已开始的下载请在浏览器下载列表查看或取消。图库变化或原件异常时请重新准备，失败的
              ZIP 请重新下载。
            </p>
            {plan.parts.length > 1 && (
              <p className="fine-print">
                浏览器如询问是否允许下载多个文件，请允许；也可逐包点击“下载 ZIP”。
              </p>
            )}
          </>
        )}
        <iframe name={frameName} title="ZIP 下载响应" className="download-frame" />
      </div>
      <footer className="modal-actions">
        <button onClick={close}>关闭</button>
        {active ? (
          <button
            disabled={stopRequested}
            onClick={() => {
              keepGoing.current = false;
              setStopRequested(true);
            }}
          >
            {stopRequested ? '本包完成后停止' : '停止后续分包'}
          </button>
        ) : (
          plan &&
          plan.parts.length > 1 && (
            <button
              className="primary"
              onClick={() => void download(plan.parts.filter((part) => part.state !== 'complete'))}
              disabled={plan.parts.every((part) => part.state === 'complete')}
            >
              <Icon name="download" />
              依次下载全部
            </button>
          )
        )}
      </footer>
    </Modal>
  );
}
