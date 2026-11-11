import { useEffect, useId, useRef, useState } from 'react';
import { albumMembers, ApiError, bytes } from './api';
import type { UploadLimits } from './api';
import { Icon, ErrorBox, Modal } from './ui';
import { MAX_UPLOAD_ITEMS, uploadEntries, uploadEntry, UploadError } from './upload-client';
import type { UploadEntry } from './upload-client';

type Phase = 'queued' | 'uploading' | 'saving' | 'created' | 'duplicate' | 'failed' | 'stopped';
interface Item extends UploadEntry {
  phase: Phase;
  percent: number;
  retryable: boolean;
  assetId?: string;
  result?: 'created' | 'duplicate';
}
const finished = (item: Item) => item.phase === 'created' || item.phase === 'duplicate';

export function Upload({
  limits,
  albumId,
  close,
  changed,
}: {
  limits: UploadLimits;
  albumId?: string | undefined;
  close: () => void;
  changed: (message: string) => void;
}) {
  const inputId = useId(),
    input = useRef<HTMLInputElement>(null),
    controller = useRef<AbortController | null>(null),
    mounted = useRef(true),
    locked = useRef(false);
  const [items, setItems] = useState<Item[]>([]),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false),
    [error, setError] = useState(''),
    [note, setNote] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  function add(files: File[]) {
    if (locked.current) return;
    setError('');
    setNote('');
    if (!files.length) {
      setError('文件选择：请直接选择或拖入照片文件，文件夹请先打开后选择文件');
      return;
    }
    if (files.length > MAX_UPLOAD_ITEMS * 2) {
      setError(`文件选择：每批最多 ${MAX_UPLOAD_ITEMS} 张照片及其配套 MOV，请分批选择`);
      return;
    }
    const entries = uploadEntries(files, limits);
    if (items.length + entries.length > MAX_UPLOAD_ITEMS) {
      setError(`上传队列：最多 ${MAX_UPLOAD_ITEMS} 项，请先清除已完成项目或分批选择`);
      return;
    }
    setItems((previous) => [
      ...previous,
      ...entries.map((entry) => ({
        ...entry,
        phase: entry.error ? ('failed' as const) : ('queued' as const),
        percent: 0,
        retryable: false,
      })),
    ]);
  }
  function patch(id: string, value: Partial<Item>) {
    if (mounted.current)
      setItems((previous) =>
        previous.map((item) => (item.id === id ? { ...item, ...value } : item)),
      );
  }
  async function run(ids?: string[]) {
    if (locked.current) return;
    const tasks = items.filter((item) =>
      ids
        ? ids.includes(item.id) && item.retryable
        : item.phase === 'queued' || item.phase === 'stopped',
    );
    if (!tasks.length) return;
    locked.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    setNote('');
    let saved = 0,
      expired = false,
      paused = false;
    try {
      for (const item of tasks) {
        if (abort.signal.aborted) break;
        patch(item.id, { phase: 'uploading', percent: 0, error: '', retryable: false });
        let assetId = item.assetId;
        let motionId = item.motionId;
        try {
          const result = assetId
            ? { id: assetId, status: item.result ?? ('duplicate' as const) }
            : await uploadEntry(
                item,
                (fraction, saving) =>
                  patch(item.id, {
                    percent: Math.min(100, Math.round(fraction * 100)),
                    phase: saving ? 'saving' : 'uploading',
                  }),
                abort.signal,
                (id) => {
                  motionId = id;
                  patch(item.id, { motionId: id });
                },
              );
          assetId = result.id;
          patch(item.id, { assetId, result: result.status, percent: 100 });
          saved++;
          if (albumId) {
            if (abort.signal.aborted) throw new DOMException('已停止上传', 'AbortError');
            patch(item.id, { phase: 'saving' });
            await albumMembers(albumId, [assetId], 'PUT');
          }
          patch(item.id, { phase: result.status, error: '', percent: 100 });
        } catch (e) {
          const caught = e as Error;
          if (caught.name === 'AbortError') {
            patch(item.id, {
              phase: 'stopped',
              error: assetId
                ? '照片已保存，尚未确认加入相册；继续时会核对结果'
                : '上传已停止，当前文件可能已保存；继续时会核对，相同内容不会重复保存',
              retryable: true,
            });
            break;
          }
          const retryable = assetId
            ? true
            : e instanceof UploadError
              ? e.retryable
              : !(e instanceof ApiError && [400, 401, 403, 413].includes(e.status));
          patch(item.id, {
            phase: 'failed',
            error: `${assetId ? '照片已保存，加入相册失败：' : motionId ? '动态部分已保存，照片尚未完成：' : ''}${caught.message}`,
            retryable,
          });
          expired = e instanceof ApiError && e.status === 401;
          if (
            expired ||
            (e instanceof ApiError && [0, 403, 409, 429].includes(e.status)) ||
            !(e instanceof ApiError) ||
            (e instanceof ApiError && e.status >= 500)
          ) {
            paused = true;
            break;
          }
        }
      }
    } finally {
      locked.current = false;
      controller.current = null;
      if (mounted.current) {
        setBusy(false);
        setNote(
          abort.signal.aborted
            ? '队列已停止。已保存的文件会保留，可继续未完成项目。'
            : paused
              ? '队列已暂停。请查看具体原因，修正后重试失败项或继续其余项目。'
              : '本批任务已结束，请查看每项结果。',
        );
        if (!expired)
          changed(
            saved
              ? `已确认 ${saved} 张照片的保存结果，照片库已刷新`
              : '上传任务已结束，照片库和用量已刷新',
          );
      }
    }
  }
  const created = items.filter((item) => item.phase === 'created').length,
    duplicates = items.filter((item) => item.phase === 'duplicate').length,
    failed = items.filter((item) => item.phase === 'failed').length,
    pending = items.filter((item) => item.phase === 'queued' || item.phase === 'stopped').length,
    retryIds = items
      .filter((item) => item.phase === 'failed' && item.retryable)
      .map((item) => item.id);
  const accept = [
    ...limits.photoExtensions.map((ext) => '.' + ext),
    ...(limits.motionBytes ? ['.mov'] : []),
  ].join(',');
  return (
    <Modal title={albumId ? '上传照片到当前相册' : '上传照片'} close={close} wide busy={busy}>
      <div className="form-body upload-body">
        <div
          className={`upload-drop ${dragging ? 'dragging' : ''} ${busy ? 'upload-busy' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            add(Array.from(event.dataTransfer.files));
          }}
        >
          <Icon name="upload" size={34} />
          <strong>把照片拖到这里</strong>
          <p>或选择照片文件，每批最多 {MAX_UPLOAD_ITEMS} 张</p>
          <input
            ref={input}
            id={inputId}
            className="sr-only"
            type="file"
            multiple
            accept={accept}
            aria-label="选择上传文件"
            disabled={busy}
            onChange={(event) => {
              add(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
            }}
          />
          <button className="primary" disabled={busy} onClick={() => input.current?.click()}>
            <Icon name="plus" size={17} />
            选择照片{limits.motionBytes ? '与 MOV' : ''}
          </button>
        </div>
        <p className="fine-print upload-guidance">
          {limits.photoExtensions.join(' / ').toUpperCase()} · 每张最多{' '}
          {limits.photoBytes.toLocaleString('en-US')} 字节
          {limits.motionBytes > 0 &&
            `；Live Photo 请同时选择同名照片和 MOV（最多 ${bytes(limits.motionBytes)}），由服务端核对配对。`}
          <br />
          优先采用原件拍摄时间；原件未注明时区时按{' '}
          {Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}{' '}
          解释，无有效拍摄时间时采用文件修改时间。可在照片资料中修正。上传期间请保持本页打开。
          {albumId && ' 照片会同时保存到图库并加入当前相册。'}
        </p>
        <ErrorBox error={error} />
        {items.length > 0 && (
          <>
            <div className="upload-summary" role="status">
              <span>
                共 {items.length} 项 · 新增 {created} · 已存在 {duplicates} · 失败 {failed} · 待处理{' '}
                {pending}
              </span>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setItems((previous) => previous.filter((item) => !finished(item)))}
              >
                清除已完成
              </button>
            </div>
            <ol className="upload-list" aria-label="上传队列">
              {items.map((item) => (
                <li className={`upload-item ${item.phase}`} key={item.id}>
                  <Icon name={finished(item) ? 'check' : 'photos'} size={22} />
                  <div className="upload-item-content">
                    <strong>{item.file.name}</strong>
                    {item.motion && <small>LIVE · {item.motion.name}</small>}
                    <span>
                      {bytes(item.file.size + (item.motion?.size ?? 0))} ·{' '}
                      {item.phase === 'created'
                        ? '已上传'
                        : item.phase === 'duplicate'
                          ? '已存在，无需重复保存'
                          : item.phase === 'failed'
                            ? '未完成'
                            : item.phase === 'stopped'
                              ? '已停止'
                              : item.phase === 'saving'
                                ? `已发送 ${item.percent}%，正在保存或核对`
                                : item.phase === 'uploading'
                                  ? `正在上传 ${item.percent}%`
                                  : '等待上传'}
                    </span>
                    {['uploading', 'saving'].includes(item.phase) && (
                      <progress
                        max={100}
                        value={item.percent}
                        aria-label={`${item.file.name} 上传进度`}
                      />
                    )}
                    {item.error && (
                      <p className="upload-item-error" role="alert">
                        {item.error}
                      </p>
                    )}
                  </div>
                  <div className="upload-row-actions">
                    {item.phase === 'failed' && item.retryable && (
                      <button
                        disabled={busy}
                        aria-label={`重试 ${item.file.name}`}
                        onClick={() => void run([item.id])}
                      >
                        重试
                      </button>
                    )}
                    <button
                      className="icon-button"
                      aria-label={`移除 ${item.file.name}`}
                      disabled={busy}
                      onClick={() =>
                        setItems((previous) => previous.filter((row) => row.id !== item.id))
                      }
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            {duplicates > 0 && (
              <p className="fine-print">已存在的照片可能位于回收站，或被当前筛选条件隐藏。</p>
            )}
          </>
        )}
        {note && (
          <p className="upload-note" role="status">
            {note}
          </p>
        )}
      </div>
      <footer className="modal-actions upload-actions">
        <button
          disabled={busy || !items.length}
          onClick={() => {
            setItems([]);
            setNote('');
            setError('');
          }}
        >
          清空队列
        </button>
        <span />
        {busy ? (
          <button className="danger" onClick={() => controller.current?.abort()}>
            停止上传
          </button>
        ) : (
          <>
            <button onClick={close}>关闭</button>
            {retryIds.length > 0 && (
              <button onClick={() => void run(retryIds)}>重试失败项（{retryIds.length}）</button>
            )}
            <button className="primary" disabled={!pending} onClick={() => void run()}>
              <Icon name="upload" size={17} />
              {items.some((item) => item.phase === 'stopped') ? '继续上传' : '开始上传'}
              {pending > 0 ? `（${pending}）` : ''}
            </button>
          </>
        )}
      </footer>
    </Modal>
  );
}
