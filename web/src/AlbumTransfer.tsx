import { useEffect, useRef, useState } from 'react';
import { api, ApiError, web, type Album } from './api';
import { albumList } from './album-list';
import { Empty, ErrorBox, Modal } from './ui';

export interface AlbumSnapshot {
  items: Album[];
  version: string;
}
interface TransferResult {
  processed: number;
  added: number;
  alreadyPresent: number;
  removed: number;
}
export function AlbumTransfer({
  ids,
  source,
  moving = false,
  close,
  changed,
}: {
  ids: string[];
  source?: string;
  moving?: boolean;
  close: () => void;
  changed: (text: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<AlbumSnapshot | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [target, setTarget] = useState(''),
    [query, setQuery] = useState(''),
    [review, setReview] = useState(false);
  const control = useRef<AbortController | null>(null);
  async function load() {
    control.current?.abort();
    const request = new AbortController();
    control.current = request;
    setLoading(true);
    setError('');
    setReview(true);
    try {
      const next = await api<AlbumSnapshot>(`${web}/albums`, 'GET', undefined, request.signal);
      if (request.signal.aborted) return;
      setSnapshot(next);
      setReview(false);
      setTarget((prior) =>
        next.items.some((album) => album.id === prior && album.id !== source) ? prior : '',
      );
    } catch (e) {
      if (!request.signal.aborted) setError((e as Error).message);
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => control.current?.abort();
  }, []);
  const available = snapshot?.items.filter((album) => album.id !== source) ?? [],
    visible = albumList(available, query),
    chosen = available.find((album) => album.id === target),
    sourceName = snapshot?.items.find((album) => album.id === source)?.albumName;
  async function submit() {
    if (!target) {
      setError('目标相册：请选择一个目标相册');
      return;
    }
    if (busy || loading || review || !snapshot) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<TransferResult>(`${web}/album-transfer`, 'POST', {
        ids,
        ...(source ? { sourceAlbumId: source } : {}),
        targetAlbumId: target,
        mode: moving ? 'move' : 'copy',
        version: snapshot.version,
      });
      changed(
        moving
          ? `已将 ${result.processed} 张照片移动到“${chosen?.albumName}”${result.alreadyPresent ? `，其中 ${result.alreadyPresent} 张已在目标相册中` : ''}`
          : `${result.added} 张照片已加入“${chosen?.albumName}”${result.alreadyPresent ? `；另有 ${result.alreadyPresent} 张已在目标相册中` : ''}`,
      );
      close();
    } catch (e) {
      setError((e as Error).message);
      if (!(e instanceof ApiError) || [404, 409, 503].includes(e.status)) setReview(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={moving ? '移动到相册' : source ? '复制到相册' : '添加到相册'}
      close={close}
      drawer
      busy={busy}
    >
      <div className="form-body album-transfer-body">
        <p className="muted">
          已选 {ids.length} 张照片{sourceName ? ` · 来源相册：“${sourceName}”` : ''}。
        </p>
        <p className="notice">
          {moving
            ? '确认后加入目标相册，并从来源相册移出；目标已有照片不会重复添加。'
            : '加入目标相册，保留照片原有的所有相册关系。'}
          相册分享内容也会随之更新。
        </p>
        <label className="field">
          查找目标相册
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={100}
            disabled={busy || loading}
            placeholder="按名称或描述查找"
          />
        </label>
        {loading && <p role="status">正在加载目标相册…</p>}
        <div className="album-targets" role="group" aria-label="目标相册">
          {visible.map((album) => (
            <button
              key={album.id}
              className="album-target"
              aria-pressed={album.id === target}
              disabled={busy || loading}
              onClick={() => setTarget(album.id)}
            >
              <strong>{album.albumName}</strong>
              <span>{album.assetCount} 张照片</span>
            </button>
          ))}
        </div>
        {chosen && <p className="fine-print">目标相册：{chosen.albumName}</p>}
        {!loading && !error && !visible.length && (
          <Empty icon="album" title={available.length ? '没有匹配的相册' : '没有其他目标相册'}>
            {available.length
              ? '请调整名称或描述搜索。'
              : '请先在相册页面新建一本相册，再来整理照片。'}
          </Empty>
        )}
        <ErrorBox error={error} />
        <button className="text-button" disabled={busy || loading} onClick={() => void load()}>
          刷新目标相册列表
        </button>
        {review && !loading && <p className="fine-print">请先刷新并核对相册内容，再重新提交。</p>}
      </div>
      <footer className="modal-actions">
        <button disabled={busy} onClick={close}>
          取消
        </button>
        <button
          className="primary"
          disabled={!target || busy || loading || review}
          onClick={() => void submit()}
        >
          {busy ? '正在整理…' : moving ? '确认移动' : '确认添加'}
        </button>
      </footer>
    </Modal>
  );
}
