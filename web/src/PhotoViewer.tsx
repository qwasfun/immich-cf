import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorBox, Icon, Modal, Preview } from './ui';
import { usePhotoCanvas } from './usePhotoCanvas';

export type ViewerMove = () => Promise<boolean> | boolean;
export function PhotoViewer({
  id,
  name,
  close,
  previous,
  next,
  loading = false,
  error = '',
  retry,
  shareToken,
  onShareLocked,
  sidebar,
  video,
  actions,
  onStartSlideshow,
}: {
  id: string;
  name: string;
  close: () => void;
  previous?: ViewerMove;
  next?: ViewerMove;
  loading?: boolean;
  error?: string;
  retry?: () => void;
  shareToken?: string;
  onShareLocked?: () => void;
  sidebar?: ReactNode;
  video?: ReactNode;
  actions?: (act: (callback: () => void) => void) => ReactNode;
  onStartSlideshow?: () => void;
}) {
  const shell = useRef<HTMLDivElement>(null),
    mounted = useRef(false),
    advancing = useRef(false);
  const [running, setRunning] = useState(false),
    [seconds, setSeconds] = useState(5),
    [message, setMessage] = useState('');
  const [fullscreen, setFullscreen] = useState(false),
    [fullscreenError, setFullscreenError] = useState('');
  const [moveError, setMoveError] = useState('');
  const runningRef = useRef(running);
  runningRef.current = running;
  const latest = useRef({ previous, next, loading, error, video, sidebar, id });
  latest.current = { previous, next, loading, error, video, sidebar, id };
  function pause() {
    setRunning(false);
    setMessage('');
  }
  async function move(side: 'previous' | 'next', automatic = false) {
    if (advancing.current || latest.current.loading) return false;
    if (!automatic) pause();
    const callback = latest.current[side];
    if (!callback) {
      if (automatic) {
        setRunning(false);
        setMessage('已播放到最后一张');
      }
      return false;
    }
    advancing.current = true;
    setMoveError('');
    try {
      const changed = await callback();
      if (mounted.current && !changed) {
        setRunning(false);
        setMessage('播放已暂停，请重试或手动翻页');
      }
      return changed;
    } catch (e) {
      if (mounted.current) {
        setRunning(false);
        setMoveError((e as Error).message || '照片：未能加载相邻照片，请重试');
      }
      return false;
    } finally {
      advancing.current = false;
    }
  }
  const canvas = usePhotoCanvas(
    id,
    pause,
    previous ? () => void move('previous') : undefined,
    next ? () => void move('next') : undefined,
    !video,
  );
  const currentCanvas = useRef(canvas);
  currentCanvas.current = canvas;
  function isTop() {
    return (
      [...document.querySelectorAll('dialog[open]')].at(-1) === shell.current?.closest('dialog')
    );
  }
  async function leaveFullscreen() {
    if (document.fullscreenElement === shell.current)
      await document.exitFullscreen().catch(() => undefined);
  }
  function requestClose() {
    pause();
    void leaveFullscreen().finally(close);
  }
  async function toggleFullscreen() {
    pause();
    setFullscreenError('');
    try {
      if (document.fullscreenElement === shell.current) await document.exitFullscreen();
      else if (shell.current?.requestFullscreen) await shell.current.requestFullscreen();
      else setFullscreenError('全屏：此浏览器不支持系统全屏，可继续在当前窗口浏览大图');
    } catch {
      setFullscreenError('全屏：浏览器未能进入系统全屏，请使用独立浏览器窗口或继续浏览大图');
    }
  }
  function toggleSlideshow() {
    if (running) {
      pause();
      return;
    }
    if (video) return;
    canvas.reset();
    onStartSlideshow?.();
    setMessage('');
    setMoveError('');
    setRunning(true);
  }
  function act(callback: () => void) {
    pause();
    void leaveFullscreen().finally(() => {
      if (mounted.current) callback();
    });
  }
  useEffect(() => {
    mounted.current = true;
    const element = shell.current;
    const changed = () => {
      setFullscreen(document.fullscreenElement === element);
      pause();
    };
    const blur = () => {
      if (!runningRef.current) return;
      setRunning(false);
      setMessage('已暂停，返回窗口后可继续播放');
    };
    const visibility = () => {
      if (document.visibilityState !== 'visible') blur();
    };
    document.addEventListener('fullscreenchange', changed);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', blur);
    return () => {
      mounted.current = false;
      document.removeEventListener('fullscreenchange', changed);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      if (document.fullscreenElement === element)
        void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (error || video || sidebar) {
      setRunning(false);
    }
  }, [error, !!video, !!sidebar]);
  useEffect(() => {
    if (!running || !canvas.ready || loading || error || video || sidebar || canvas.failed) return;
    const timer = window.setTimeout(() => {
      if (!isTop()) {
        pause();
        return;
      }
      void move('next', true);
    }, seconds * 1000);
    return () => clearTimeout(timer);
  }, [running, id, canvas.ready, canvas.failed, loading, error, seconds, !!video, !!sidebar]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!isTop() || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select,[contenteditable="true"]')) return;
      const image = currentCanvas.current;
      if (
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) &&
        !latest.current.video
      ) {
        event.preventDefault();
        if (image.view.scale > 1)
          image.pan(
            event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0,
            event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0,
          );
        else if (event.key === 'ArrowLeft') void move('previous');
        else if (event.key === 'ArrowRight') void move('next');
      } else if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault();
        void move(event.key === 'PageUp' ? 'previous' : 'next');
      } else if (
        (event.key === '+' || event.key === '=' || event.key === '-') &&
        !latest.current.video
      ) {
        event.preventDefault();
        image.zoom(image.view.scale + (event.key === '-' ? -0.25 : 0.25));
      } else if (event.key === '0') {
        event.preventDefault();
        pause();
        image.reset();
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        void toggleFullscreen();
      } else if (event.key === ' ' && !target.closest('button,a')) {
        event.preventDefault();
        if (!latest.current.video && !image.failed) {
          if (runningRef.current) pause();
          else {
            image.reset();
            onStartSlideshow?.();
            setRunning(true);
            setMessage('');
          }
        }
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  function escape() {
    pause();
    if (canvas.view.scale > 1) canvas.reset();
    else if (document.fullscreenElement === shell.current) void leaveFullscreen();
    else requestClose();
  }
  const fit = canvas.fitted;
  return (
    <Modal
      title={name}
      close={requestClose}
      onEscape={escape}
      wide
      contentRef={shell}
      contentClassName="viewer-shell"
    >
      <div className="viewer-tools" role="toolbar" aria-label="大图浏览工具">
        <button
          aria-label="缩小"
          disabled={!canvas.ready || !!video || canvas.view.scale <= 1}
          onClick={() => canvas.zoom(canvas.view.scale - 0.25)}
          title="缩小（-）"
        >
          −
        </button>
        <output aria-label="放大比例">{Math.round(canvas.view.scale * 100)}%</output>
        <button
          aria-label="放大"
          disabled={!canvas.ready || !!video || canvas.view.scale >= 4}
          onClick={() => canvas.zoom(canvas.view.scale + 0.25)}
          title="放大（+）"
        >
          ＋
        </button>
        <button
          disabled={!!video || !canvas.ready}
          onClick={() => {
            pause();
            canvas.reset();
          }}
          title="适应窗口（0）；双击照片切换缩放"
        >
          适应窗口
        </button>
        <button onClick={() => void toggleFullscreen()} aria-pressed={fullscreen} title="全屏（F）">
          {fullscreen ? '退出全屏' : '全屏'}
        </button>
        <button
          disabled={!!video || canvas.failed}
          onClick={toggleSlideshow}
          aria-pressed={running}
        >
          {running ? '暂停幻灯片' : '开始幻灯片'}
        </button>
        <label className="viewer-interval">
          每张
          <select
            aria-label="幻灯片间隔"
            value={seconds}
            onChange={(e) => {
              pause();
              setSeconds(Number(e.target.value));
            }}
          >
            {[3, 5, 10].map((value) => (
              <option key={value} value={value}>
                {value} 秒
              </option>
            ))}
          </select>
        </label>
        <span className="viewer-shortcuts">双击缩放 · 放大后拖动 · ← → 翻页</span>
      </div>
      {(loading || error || moveError || fullscreenError || message) && (
        <div className="viewer-feedback">
          {loading && <p role="status">正在加载相邻照片…</p>}
          <ErrorBox error={error || moveError} retry={retry} />
          <ErrorBox error={fullscreenError} />
          {message && <p role="status">{message}</p>}
        </div>
      )}
      <div className="viewer-body">
        <div className="viewer-stage">
          {video || (
            <div
              ref={canvas.root}
              className={`photo-canvas ${canvas.view.scale > 1 ? 'zoomed' : ''}`}
              data-zoom={canvas.view.scale}
              {...canvas.handlers}
            >
              <div
                className="canvas-image"
                style={{
                  left: fit.width ? '50%' : 0,
                  top: fit.height ? '50%' : 0,
                  width: fit.width || '100%',
                  height: fit.height || '100%',
                  marginLeft: fit.width ? -fit.width / 2 : undefined,
                  marginTop: fit.height ? -fit.height / 2 : undefined,
                  transform: `translate3d(${canvas.view.x}px,${canvas.view.y}px,0) scale(${canvas.view.scale})`,
                }}
              >
                <Preview
                  key={id}
                  id={id}
                  name={name}
                  large
                  shareToken={shareToken}
                  onShareLocked={onShareLocked}
                  onReady={canvas.loaded}
                  onPreviewError={canvas.onError}
                />
              </div>
            </div>
          )}
          {previous && (
            <button
              className="viewer-arrow previous"
              aria-label="上一张"
              disabled={loading}
              onClick={() => void move('previous')}
            >
              <Icon name="left" size={28} />
            </button>
          )}
          {next && (
            <button
              className="viewer-arrow next"
              aria-label="下一张"
              disabled={loading}
              onClick={() => void move('next')}
            >
              <Icon name="right" size={28} />
            </button>
          )}
        </div>
        {sidebar}
      </div>
      {actions && <div className="viewer-actions">{actions(act)}</div>}
    </Modal>
  );
}
