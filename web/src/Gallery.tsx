import { useEffect, useRef, useState } from 'react';
import { api, albumMembers, bytes, date, web } from './api';
import type { Album, Page, Photo } from './api';
import { Confirm, Empty, ErrorBox, FormModal, Icon, Modal, Preview } from './ui';

type Changed = (message: string) => void;
function PhotoCard({
  photo,
  selected,
  select,
  open,
}: {
  photo: Photo;
  selected: boolean;
  select: () => void;
  open: () => void;
}) {
  return (
    <article className={`photo-tile ${selected ? 'selected' : ''}`}>
      <Preview id={photo.id} name={photo.originalFileName} />
      <button className="photo-open" aria-label={`查看 ${photo.originalFileName}`} onClick={open} />
      <button
        className="photo-select"
        aria-label={`${selected ? '取消选择' : '选择'} ${photo.originalFileName}`}
        aria-pressed={selected}
        onClick={select}
      >
        {selected ? <Icon name="check" size={17} /> : <span />}
      </button>
      <div className="photo-badges">
        {photo.livePhotoVideoId && (
          <span>
            <Icon name="play" size={12} />
            LIVE
          </span>
        )}
        {photo.isFavorite && (
          <span className="favorite-badge">
            <Icon name="heart" size={14} />
          </span>
        )}
      </div>
      <span className="photo-filename">{photo.originalFileName}</span>
    </article>
  );
}
export function Picker({
  title,
  close,
  submit,
}: {
  title: string;
  close: () => void;
  submit: (ids: string[]) => Promise<void>;
}) {
  const [items, setItems] = useState<Photo[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  async function load(next?: string) {
    setLoading(true);
    setError('');
    try {
      const page = await api<Page<Photo>>(
        `${web}/assets?view=photos${next ? '&cursor=' + encodeURIComponent(next) : ''}`,
      );
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <Modal title={title} close={close} wide busy={busy}>
      <div className="form-body picker-body">
        <p className="muted">选择已备份的照片 · 已选 {selected.size} 项（最多 1000 项）</p>
        <ErrorBox
          error={error}
          retry={() => {
            setSelected(new Set());
            void load();
          }}
        />
        <div className="photo-grid picker-grid">
          {items.map((p) => (
            <PhotoCard
              key={p.id}
              photo={p}
              selected={selected.has(p.id)}
              open={() => toggle(p.id)}
              select={() => toggle(p.id)}
            />
          ))}
        </div>
        {!loading && !error && !items.length && (
          <Empty title="还没有照片">请先通过 App 备份照片。</Empty>
        )}
        {loading && <p className="muted">正在加载…</p>}
        {cursor && (
          <button disabled={loading || busy} onClick={() => void load(cursor)}>
            加载更多照片
          </button>
        )}
      </div>
      <footer className="modal-actions">
        <button onClick={close} disabled={busy}>
          取消
        </button>
        <button
          className="primary"
          disabled={!selected.size || busy || loading}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await submit([...selected]);
              close();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '正在添加…' : `添加 ${selected.size || ''} 张照片`}
        </button>
      </footer>
    </Modal>
  );
  function toggle(id: string) {
    if (busy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 1000) next.add(id);
      else setError('所选照片：每次最多 1000 项，请分批添加');
      return next;
    });
  }
}

function AlbumChoice({
  ids,
  close,
  changed,
}: {
  ids: string[];
  close: () => void;
  changed: Changed;
}) {
  const [albums, setAlbums] = useState<Album[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [target, setTarget] = useState('');
  useEffect(() => {
    api<Album[]>('/api/albums')
      .then((rows) => {
        setAlbums(rows);
        setTarget(rows[0]?.id ?? '');
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <Modal title="添加到相册" close={close} busy={busy}>
      <div className="form-body">
        <p className="muted">将 {ids.length} 张照片添加到个人相册，原有照片会保留。</p>
        <label className="field">
          选择相册
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.albumName}
              </option>
            ))}
          </select>
        </label>
        {!albums.length && !error && <p>还没有相册，请先在“相册”页面创建。</p>}
        <ErrorBox error={error} />
      </div>
      <footer className="modal-actions">
        <button disabled={busy} onClick={close}>
          取消
        </button>
        <button
          className="primary"
          disabled={!target || busy}
          onClick={async () => {
            setBusy(true);
            try {
              changed(await albumMembers(target, ids, 'PUT'));
              close();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '正在添加…' : '添加到相册'}
        </button>
      </footer>
    </Modal>
  );
}

function Viewer({
  photo,
  previous,
  next,
  close,
  favorite,
  remove,
  addAlbum,
}: {
  photo: Photo;
  previous?: () => void;
  next?: () => void;
  close: () => void;
  favorite: () => void;
  remove: () => void;
  addAlbum: () => void;
}) {
  const [info, setInfo] = useState(false),
    [play, setPlay] = useState(false),
    [videoError, setVideoError] = useState(false),
    [startX, setStartX] = useState<number | null>(null);
  useEffect(() => {
    setPlay(false);
    setVideoError(false);
  }, [photo.id]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        previous?.();
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        next?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [previous, next]);
  return (
    <Modal title={photo.originalFileName} close={close} wide>
      <div className="viewer-body">
        <div
          className="viewer-stage"
          onTouchStart={(e) => setStartX(e.touches[0].clientX)}
          onTouchEnd={(e) => {
            if (startX !== null && !play) {
              const delta = e.changedTouches[0].clientX - startX;
              if (delta > 70) previous?.();
              if (delta < -70) next?.();
            }
            setStartX(null);
          }}
        >
          {play && photo.livePhotoVideoId ? (
            <div className="video-wrap">
              <video
                key={photo.id}
                controls
                playsInline
                autoPlay
                preload="metadata"
                src={`/api/assets/${photo.livePhotoVideoId}/video/playback`}
                onError={() => setVideoError(true)}
              />
              {videoError && (
                <p role="alert">当前浏览器无法播放此 MOV，请下载原件后使用兼容的播放器查看。</p>
              )}
              <button onClick={() => setPlay(false)}>返回照片</button>
            </div>
          ) : (
            <Preview key={photo.id} id={photo.id} large name={photo.originalFileName} />
          )}
          {previous && (
            <button className="viewer-arrow previous" aria-label="上一张" onClick={previous}>
              <Icon name="left" size={28} />
            </button>
          )}
          {next && (
            <button className="viewer-arrow next" aria-label="下一张" onClick={next}>
              <Icon name="right" size={28} />
            </button>
          )}
        </div>
        {info && (
          <aside className="photo-info">
            <h3>照片信息</h3>
            <dl>
              <dt>文件名</dt>
              <dd>{photo.originalFileName}</dd>
              <dt>拍摄时间</dt>
              <dd>{date(photo.fileCreatedAt)}</dd>
              <dt>尺寸</dt>
              <dd>
                {photo.width} × {photo.height}
              </dd>
              <dt>格式 / 大小</dt>
              <dd>
                {photo.originalMimeType.replace('image/', '').toUpperCase()} · {bytes(photo.bytes)}
              </dd>
              {photo.deletedAt && (
                <>
                  <dt>删除时间</dt>
                  <dd>{date(photo.deletedAt)}</dd>
                </>
              )}
              {photo.livePhotoVideoId && (
                <>
                  <dt>动态照片</dt>
                  <dd>照片与 MOV 原件已配对。播放取决于浏览器支持。</dd>
                </>
              )}
            </dl>
          </aside>
        )}
      </div>
      <div className="viewer-actions">
        {!photo.isTrashed && (
          <>
            <button onClick={favorite} className={photo.isFavorite ? 'is-favorite' : ''}>
              <Icon name="heart" />
              {photo.isFavorite ? '取消收藏' : '收藏'}
            </button>
            <button onClick={addAlbum}>
              <Icon name="album" />
              加入相册
            </button>
            <button onClick={remove}>
              <Icon name="trash" />
              删除
            </button>
          </>
        )}
        <a className="button" href={photo.downloadPath}>
          <Icon name="download" />
          下载原件
        </a>
        {photo.livePhotoVideoId && (
          <>
            <button onClick={() => setPlay(true)}>
              <Icon name="play" />
              播放动态
            </button>
            <a className="button" href={`${photo.downloadPath}?component=motion`}>
              <Icon name="download" />
              下载 MOV
            </a>
          </>
        )}
        <button onClick={() => setInfo((v) => !v)} aria-pressed={info}>
          <Icon name="info" />
          详情
        </button>
      </div>
    </Modal>
  );
}

export function Gallery({
  view,
  albumId = '',
  refresh,
  changed,
}: {
  view: string;
  albumId?: string;
  refresh: number;
  changed: Changed;
}) {
  const loadVersion = useRef(0);
  const [items, setItems] = useState<Photo[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [opened, setOpened] = useState<Photo | null>(null),
    [album, setAlbum] = useState<Album | null>(null),
    [dialog, setDialog] = useState(''),
    [targets, setTargets] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const title =
    view === 'photos'
      ? '照片'
      : view === 'favorites'
        ? '收藏'
        : view === 'trash'
          ? '回收站'
          : (album?.albumName ?? '相册');
  async function load(next?: string) {
    const version = ++loadVersion.current;
    setLoading(true);
    setError('');
    try {
      const page = await api<Page<Photo>>(
        `${web}/assets?view=${view}${albumId ? '&albumId=' + albumId : ''}${next ? '&cursor=' + encodeURIComponent(next) : ''}`,
      );
      if (version !== loadVersion.current) return;
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      if (version === loadVersion.current) setError((e as Error).message);
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    let live = true;
    setItems([]);
    setCursor(null);
    setSelected(new Set());
    void load();
    if (albumId)
      api<Album>(`/api/albums/${albumId}`)
        .then((a) => {
          if (live) setAlbum(a);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
      loadVersion.current++;
    };
  }, [view, albumId, refresh]);
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 1000) next.add(id);
      else setError('所选照片：每次最多 1000 项，请分批操作');
      return next;
    });
  }
  function ask(kind: string, ids = [...selected]) {
    setTargets(ids);
    setDialog(kind);
  }
  async function favorite(ids: string[], value: boolean) {
    setBusy(true);
    setError('');
    try {
      await api('/api/assets', 'PUT', { ids, isFavorite: value });
      if (opened && ids.includes(opened.id)) setOpened({ ...opened, isFavorite: value });
      changed(value ? '已加入收藏' : '已取消收藏');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function setCover(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/albums/${albumId}`, 'PATCH', { albumThumbnailAssetId: id });
      changed('相册封面已更新');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const groups = new Map<string, Photo[]>();
  for (const p of items) {
    const key = new Date(view === 'trash' ? p.deletedAt! : p.fileCreatedAt).toLocaleDateString(
      'zh-CN',
      { year: 'numeric', month: 'long', day: 'numeric' },
    );
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const done = (message: string) => {
    setOpened(null);
    setSelected(new Set());
    changed(message);
  };
  const close = () => setDialog('');
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {view === 'trash'
              ? 'TRASH'
              : view === 'album'
                ? 'PERSONAL ALBUM'
                : view === 'favorites'
                  ? 'FAVORITES'
                  : 'YOUR PHOTO LIBRARY'}
          </p>
          <h1>{title}</h1>
          <p className="muted">
            {view === 'photos'
              ? '值得珍藏的日常，在这里慢慢回看。'
              : view === 'favorites'
                ? '把喜欢的瞬间，放在一起。'
                : view === 'trash'
                  ? '已删除的照片仍可恢复，永久删除后无法找回。'
                  : album?.description || '让每一段回忆，都有自己的位置。'}
          </p>
        </div>
        <div className="heading-actions">
          {album && (
            <>
              <button onClick={() => setDialog('edit-album')}>编辑相册</button>
              <button className="primary" onClick={() => setDialog('picker')}>
                <Icon name="plus" />
                添加照片
              </button>
            </>
          )}
          {view === 'trash' && (
            <>
              <button disabled={loading} onClick={() => ask('restore-all')}>
                全部恢复
              </button>
              <button className="danger" disabled={loading} onClick={() => ask('empty')}>
                清空回收站
              </button>
            </>
          )}
        </div>
      </div>
      {selected.size > 0 && (
        <div className="selection-toolbar">
          <strong>已选择 {selected.size} 项</strong>
          <button onClick={() => setSelected(new Set())}>取消选择</button>
          {view === 'trash' ? (
            <>
              <button onClick={() => ask('restore')}>恢复所选</button>
              <button className="danger" onClick={() => ask('purge')}>
                永久删除
              </button>
            </>
          ) : (
            <>
              <button
                disabled={busy}
                onClick={() => void favorite([...selected], view !== 'favorites')}
              >
                {view === 'favorites' ? '取消收藏' : '收藏'}
              </button>
              <button onClick={() => ask('album')}>加入相册</button>
              {albumId && <button onClick={() => ask('remove-album')}>移出相册</button>}
              {albumId && selected.size === 1 && (
                <button disabled={busy} onClick={() => void setCover([...selected][0])}>
                  设为封面
                </button>
              )}
              <button className="danger" onClick={() => ask('trash')}>
                移入回收站
              </button>
            </>
          )}
        </div>
      )}
      <div className="list-summary">
        <span>
          {loading ? '正在加载照片…' : `已加载 ${items.length} 张${cursor ? ' · 还有更多' : ''}`}
        </span>
        {items.length > 0 && (
          <button
            className="text-button"
            onClick={() =>
              selected.size
                ? setSelected(new Set())
                : setSelected(new Set(items.slice(0, 1000).map((p) => p.id)))
            }
          >
            {selected.size
              ? '取消选择'
              : `选择已加载项目${items.length > 1000 ? '（前 1000 项）' : ''}`}
          </button>
        )}
      </div>
      <ErrorBox
        error={error}
        retry={() => {
          setSelected(new Set());
          void load();
        }}
      />
      {[...groups].map(([label, photos]) => (
        <section className="day-group" key={label}>
          <h2>
            {label}
            <span>{photos.length}</span>
          </h2>
          <div className="photo-grid">
            {photos.map((p) => (
              <PhotoCard
                key={p.id}
                photo={p}
                selected={selected.has(p.id)}
                select={() => toggle(p.id)}
                open={() => setOpened(p)}
              />
            ))}
          </div>
        </section>
      ))}
      {!loading && !error && !items.length && (
        <Empty
          icon={view === 'trash' ? 'trash' : view === 'favorites' ? 'heart' : 'photos'}
          title={
            view === 'trash'
              ? '回收站是空的'
              : view === 'favorites'
                ? '还没有收藏'
                : '这里还没有照片'
          }
        >
          {view === 'photos'
            ? '通过 Immich App 备份后，照片会出现在这里。'
            : view === 'favorites'
              ? '在照片预览中点击收藏，留下你喜欢的瞬间。'
              : view === 'album'
                ? '点击“添加照片”，从已备份的图库中选择。'
                : '从图库删除的照片会出现在这里。'}
        </Empty>
      )}
      {cursor && !error && (
        <div className="load-more">
          <button disabled={loading} onClick={() => void load(cursor)}>
            {loading ? '正在加载…' : '加载更多照片'}
          </button>
        </div>
      )}
      {opened && (
        <Viewer
          photo={opened}
          close={() => setOpened(null)}
          previous={
            items.findIndex((p) => p.id === opened.id) > 0
              ? () => setOpened(items[items.findIndex((p) => p.id === opened.id) - 1])
              : undefined
          }
          next={
            items.findIndex((p) => p.id === opened.id) >= 0 &&
            items.findIndex((p) => p.id === opened.id) < items.length - 1
              ? () => setOpened(items[items.findIndex((p) => p.id === opened.id) + 1])
              : undefined
          }
          favorite={() => void favorite([opened.id], !opened.isFavorite)}
          remove={() => ask('trash', [opened.id])}
          addAlbum={() => ask('album', [opened.id])}
        />
      )}
      {dialog === 'album' && <AlbumChoice ids={targets} close={close} changed={changed} />}
      {dialog === 'picker' && (
        <Picker
          title="添加照片到相册"
          close={close}
          submit={async (ids) => {
            done(await albumMembers(albumId, ids, 'PUT'));
          }}
        />
      )}
      {dialog === 'edit-album' && album && (
        <FormModal
          title="编辑相册"
          close={close}
          fields={[
            { key: 'albumName', label: '相册名称', value: album.albumName },
            { key: 'description', label: '相册描述', value: album.description, optional: true },
          ]}
          submit={async (values) => {
            await api(`/api/albums/${albumId}`, 'PATCH', values);
            changed('相册已保存');
          }}
        />
      )}
      {['trash', 'purge', 'restore', 'restore-all', 'empty', 'remove-album'].includes(dialog) && (
        <Confirm
          title={
            dialog === 'trash'
              ? '移入回收站？'
              : dialog === 'remove-album'
                ? '移出相册？'
                : dialog.includes('restore')
                  ? '恢复照片？'
                  : '永久删除照片？'
          }
          description={
            dialog === 'trash'
              ? `将 ${targets.length} 张照片移入回收站，之后可以恢复。动态照片按整组处理。`
              : dialog === 'remove-album'
                ? `从此相册移除 ${targets.length} 张照片，图库中的照片会保留。`
                : dialog === 'restore-all'
                  ? '将恢复当前账号回收站中的全部照片，包含尚未加载的项目。'
                  : dialog === 'restore'
                    ? `将恢复所选 ${targets.length} 张照片及仍存在的相册关系。`
                    : dialog === 'empty'
                      ? '将永久删除当前账号回收站中的全部照片，包含尚未加载的项目。照片与配套动态视频均无法恢复。'
                      : `将永久删除所选 ${targets.length} 张照片及配套动态视频，此操作无法撤销。`
          }
          danger={dialog === 'purge' || dialog === 'empty'}
          label={dialog === 'purge' || dialog === 'empty' ? '永久删除' : '确定'}
          close={close}
          done={(result) =>
            done(
              dialog.includes('restore')
                ? '照片已恢复'
                : dialog === 'remove-album'
                  ? String(result)
                  : dialog === 'trash'
                    ? '照片已移入回收站'
                    : '永久删除已提交，后台将继续清理文件',
            )
          }
          action={() =>
            dialog === 'remove-album'
              ? albumMembers(albumId, targets, 'DELETE')
              : dialog === 'restore-all'
                ? api('/api/trash/restore', 'POST', {})
                : dialog === 'restore'
                  ? api('/api/trash/restore/assets', 'POST', { ids: targets })
                  : dialog === 'empty'
                    ? api('/api/trash/empty', 'POST', {})
                    : api('/api/assets', 'DELETE', { ids: targets, force: dialog === 'purge' })
          }
        />
      )}
    </>
  );
}

export function Albums({
  refresh,
  changed,
  navigate,
}: {
  refresh: number;
  changed: Changed;
  navigate: (path: string) => void;
}) {
  const [items, setItems] = useState<Album[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [create, setCreate] = useState(false),
    [remove, setRemove] = useState<Album | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api<Album[]>('/api/albums')
      .then((rows) => {
        if (active) setItems(rows);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PERSONAL ALBUMS</p>
          <h1>相册</h1>
          <p className="muted">给回忆一个名字，让故事好好珍藏。</p>
        </div>
        <button className="primary" onClick={() => setCreate(true)}>
          <Icon name="plus" />
          新建相册
        </button>
      </div>
      <ErrorBox error={error} retry={() => changed('正在重新加载相册')} />
      {loading && <p className="muted">正在加载相册…</p>}
      <div className="album-grid">
        {items.map((a) => (
          <article className="album-card" key={a.id}>
            <div className="album-cover">
              {a.albumThumbnailAssetId ? (
                <Preview id={a.albumThumbnailAssetId} name={a.albumName} />
              ) : (
                <Icon name="album" size={42} />
              )}
            </div>
            <div className="album-meta">
              <button className="album-open" onClick={() => navigate(`/albums/${a.id}`)}>
                <strong>{a.albumName}</strong>
                <span>{a.assetCount} 张照片</span>
              </button>
              <button
                className="icon-button"
                aria-label={`删除相册 ${a.albumName}`}
                onClick={() => setRemove(a)}
              >
                <Icon name="trash" size={17} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {!loading && !error && !items.length && (
        <Empty icon="album" title="创建第一本相册">
          旅行、家人，或平凡又特别的一天。
        </Empty>
      )}
      {create && (
        <FormModal
          title="新建相册"
          close={() => setCreate(false)}
          fields={[
            { key: 'albumName', label: '相册名称' },
            { key: 'description', label: '相册描述', optional: true },
          ]}
          label="创建相册"
          submit={async (values) => {
            const a = await api<Album>('/api/albums', 'POST', values);
            changed('相册已创建');
            navigate(`/albums/${a.id}`);
          }}
        />
      )}
      {remove && (
        <Confirm
          title="删除相册？"
          description={`删除“${remove.albumName}”后，相册中的照片仍保留在图库中。`}
          action={() => api(`/api/albums/${remove.id}`, 'DELETE')}
          close={() => setRemove(null)}
          done={() => changed('相册已删除，照片仍保留')}
          label="删除相册"
          danger
        />
      )}
    </>
  );
}
