import { useEffect, useRef, useState } from 'react';
import type { GpsFailure, GpsJob, GpsPlan } from '../../src/gps-job-info';
import { api, web } from './api';
import { ErrorBox, Modal } from './ui';

const root = web + '/gps-jobs';
const sourceNames: Record<string, string> = {
  library: '全部照片（含归档）',
  photos: '照片',
  favorites: '收藏',
  archive: '归档',
  album: '个人相册',
};
function scopeText(scope: string, sourceName?: string) {
  const params = new URLSearchParams(scope),
    filters = [];
  if (params.get('q')) filters.push('文件名：' + params.get('q'));
  if (params.get('tag')) filters.push('标签：' + params.get('tag'));
  if (params.get('type'))
    filters.push(
      '照片类型：' +
        ({ live: '动态照片', static: '静态照片', jpeg: 'JPEG', png: 'PNG', heic: 'HEIC' }[
          params.get('type')!
        ] ?? '全部'),
    );
  if (params.get('rating'))
    filters.push(
      '评分：' +
        (params.get('rating') === 'none'
          ? '未评分'
          : params.get('rating')!.startsWith('gte')
            ? params.get('rating')!.slice(3) + ' 星及以上'
            : params.get('rating') + ' 星'),
    );
  if (params.get('from') || params.get('to')) filters.push('已限定拍摄日期');
  return [sourceName ?? sourceNames[params.get('mapView') ?? 'library'], ...filters].join(' · ');
}
export function GpsReader({
  scope,
  close,
  updated,
}: {
  scope: string;
  close: () => void;
  updated: () => void;
}) {
  const [job, setJob] = useState<GpsJob | null>(null),
    [plan, setPlan] = useState<GpsPlan | null>(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [working, setWorking] = useState(false),
    [busy, setBusy] = useState(false);
  const live = useRef(true),
    running = useRef(false),
    generation = useRef(0),
    controller = useRef(new AbortController());
  const latestUpdated = useRef(updated);
  const loadVersion = useRef(0);
  latestUpdated.current = updated;
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    live.current = true;
    controller.current = new AbortController();
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    void load();
    return () => {
      live.current = false;
      running.current = false;
      generation.current++;
      controller.current.abort();
      clearInterval(timer);
    };
  }, []);
  // A paused/closed tab can still have one request finishing. Show its committed result.
  useEffect(() => {
    if (working || !job || job.leaseUntil <= clock) return;
    const abort = new AbortController();
    api<GpsJob>(root + '/' + job.id, 'GET', undefined, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted && live.current) setJob(result);
      })
      .catch(() => {
        /* The explicit refresh retains the specific error if connectivity is lost. */
      });
    return () => abort.abort();
  }, [clock, working, job?.id, job?.leaseUntil]);
  async function refreshPlan() {
    const result = await api<GpsPlan>(root + '/preview?' + scope);
    if (live.current) setPlan(result);
  }
  async function load() {
    const version = ++loadVersion.current;
    setLoading(true);
    setError('');
    try {
      const [latest, preview] = await Promise.allSettled([
        api<GpsJob | null>(root),
        api<GpsPlan>(root + '/preview?' + scope),
      ]);
      if (live.current && version === loadVersion.current) {
        if (latest.status === 'fulfilled') setJob(latest.value);
        setPlan(preview.status === 'fulfilled' ? preview.value : null);
        const errors = [latest, preview].flatMap((result) =>
          result.status === 'rejected' ? [(result.reason as Error).message] : [],
        );
        if (errors.length) setError([...new Set(errors)].join('；'));
      }
    } catch (e) {
      if (live.current && version === loadVersion.current) setError((e as Error).message);
    } finally {
      if (live.current && version === loadVersion.current) setLoading(false);
    }
  }
  async function run(start: GpsJob) {
    if (running.current) return;
    const token = ++generation.current;
    running.current = true;
    setWorking(true);
    setPlan(null);
    setError('');
    let next = start;
    try {
      while (
        live.current &&
        running.current &&
        token === generation.current &&
        next.state === 'running'
      ) {
        if (next.leaseUntil > Date.now()) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
          if (!live.current || !running.current || token !== generation.current) break;
          next = await api<GpsJob>(
            root + '/' + next.id,
            'GET',
            undefined,
            controller.current.signal,
          );
        } else
          next = await api<GpsJob>(
            root + '/' + next.id + '/step',
            'POST',
            {},
            controller.current.signal,
          );
        if (live.current && token === generation.current) setJob(next);
      }
    } catch (e) {
      if (live.current && token === generation.current) {
        setError((e as Error).message + '；本页已停止推进，请先刷新服务端进度，再继续读取。');
        // A timed-out write may already have committed; reconcile without replaying it.
        try {
          const known = await api<GpsJob>(root + '/' + next.id);
          if (live.current && token === generation.current) setJob(known);
        } catch {
          /* Keep the original actionable error and saved progress. */
        }
      }
    } finally {
      if (live.current && token === generation.current) {
        running.current = false;
        setWorking(false);
        latestUpdated.current();
        void refreshPlan().catch(() => {
          /* The existing job remains usable; refresh can retry the plan. */
        });
      }
    }
  }
  function stopLocal() {
    running.current = false;
    generation.current++;
    setWorking(false);
  }
  async function start() {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      const created = await api<GpsJob>(root, 'POST', { scope, version: plan.version });
      if (live.current) {
        setJob(created);
        void run(created);
      }
    } catch (e) {
      if (live.current) {
        setError((e as Error).message + '；请刷新进度确认后再操作。');
        try {
          const known = await api<GpsJob | null>(root);
          if (live.current) setJob(known);
        } catch {
          /* Explicit refresh is available. */
        }
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function command(action: string, ids?: string[]) {
    if (!job) return;
    stopLocal();
    setBusy(true);
    setPlan(null);
    setError('');
    try {
      const result = await api<GpsJob>(root + '/' + job.id, 'PATCH', {
        action,
        ...(ids ? { ids } : {}),
      });
      if (!live.current) return;
      setJob(result);
      if (action === 'resume' || action === 'retry') void run(result);
      else {
        latestUpdated.current();
        void refreshPlan().catch(() => {});
      }
    } catch (e) {
      if (live.current) {
        setError((e as Error).message + '；请刷新进度确认后再操作。');
        try {
          const known = await api<GpsJob>(root + '/' + job.id);
          if (live.current) setJob(known);
        } catch {
          /* Preserve error and current progress. */
        }
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function moreFailures() {
    if (!job?.nextFailure) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<GpsJob>(root + '/' + job.id + '?failureAfter=' + job.nextFailure);
      const merged = new Map<string, GpsFailure>(
        job.failures.map((failure) => [failure.id, failure]),
      );
      for (const failure of result.failures) merged.set(failure.id, failure);
      if (live.current) setJob({ ...result, failures: [...merged.values()] });
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const active = job && ['running', 'paused'].includes(job.state),
    leased = !!job && job.leaseUntil > clock;
  const retryable =
    !!job && job.failed > 0 && ['paused', 'complete'].includes(job.state) && !leased && !working;
  return (
    <Modal
      title="批量读取旧照片 GPS"
      wide
      busy={busy}
      close={() => {
        stopLocal();
        latestUpdated.current();
        close();
      }}
    >
      <div className="form-body gps-reader-body">
        <p>
          读取尚未提取原件资料的照片，包含未出现在地图上的项目；按照片来源和筛选处理，不按当前地图窗口限制。
        </p>
        <p className="fine-print">
          保留手动修正或清除的位置、描述及拍摄时间，不修改原件。无可用定位也会记为读取完成。关闭面板或页面只停止本页继续请求，在途读取可能完成；重新打开可恢复服务端进度。
        </p>
        <ErrorBox error={error} retry={working ? undefined : () => void load()} />
        {loading && <p role="status">正在读取任务进度与待处理数量…</p>}
        {job && (
          <section className="gps-progress" aria-label="GPS 读取进度">
            <h3>
              {job.state === 'cancelled'
                ? '任务已结束'
                : working
                  ? '正在读取原件信息'
                  : leased
                    ? '正在确认上次读取结果'
                    : job.state === 'complete'
                      ? job.failed
                        ? '本轮读取结束，部分照片失败'
                        : '本轮读取完成'
                      : '任务已保存，可继续读取'}
            </h3>
            <p className="muted">任务范围：{scopeText(job.scope, job.sourceName)}</p>
            <progress aria-label="照片处理进度" max={job.total || 1} value={job.processed} />
            <p role="status" className="gps-counter">
              已处理 {job.processed.toLocaleString()} / {job.total.toLocaleString()} 张 · 剩余{' '}
              {job.pending.toLocaleString()} 张
            </p>
            <div className="gps-counts">
              <span>读取成功 {job.succeeded}</span>
              <span>可定位 {job.located}</span>
              <span>无可用定位 {job.noGps}</span>
              <span>跳过 {job.skipped}</span>
              <span>失败 {job.failed}</span>
            </div>
            {job.currentFile && <p className="gps-file">正在处理：{job.currentFile}</p>}
            {!job.currentFile && job.lastResult && (
              <p className="gps-file">
                最近处理：{job.lastResult.filename}
                {job.lastResult.message ? ' · ' + job.lastResult.message : ''}
              </p>
            )}
            {leased && !working && (
              <p className="fine-print">
                上次请求仍在确认中，进度会自动刷新；请等待当前请求完成或恢复可用后继续。
              </p>
            )}
            {job.state === 'cancelled' && job.pending > 0 && (
              <p className="fine-print">
                剩余 {job.pending} 张没有读取，已完成的照片资料保留。可按当前地图筛选开始新任务。
              </p>
            )}
            <div className="gps-actions">
              {working ? (
                <button disabled={busy} onClick={() => void command('pause')}>
                  暂停读取
                </button>
              ) : (
                active && (
                  <button
                    className="primary"
                    disabled={busy || loading}
                    onClick={() => void command('resume')}
                  >
                    {leased ? '等待结果并继续' : '继续读取'}
                  </button>
                )
              )}
              {active && (
                <button disabled={busy} onClick={() => void command('cancel')}>
                  结束任务
                </button>
              )}
              {retryable && (
                <button className="primary" disabled={busy} onClick={() => void command('retry')}>
                  重试全部失败（{job.failed}）{job.pending ? '并继续' : ''}
                </button>
              )}
            </div>
          </section>
        )}
        {!active && plan && (
          <section className="gps-new-task">
            <h3>{job ? '按当前筛选开始新任务' : '准备读取'}</h3>
            <p className="muted">当前范围：{scopeText(scope, plan.sourceName)}</p>
            <p>
              找到 <strong>{plan.count.toLocaleString()}</strong> 张尚未读取原件资料的照片。
            </p>
            {job && (
              <p className="fine-print">
                新任务会替换本次已结束的进度记录，已保存的照片资料保留。失败项目也可先用“重试全部失败”继续处理。
              </p>
            )}
            <button
              className="primary"
              disabled={!plan.count || busy || loading}
              onClick={() => void start()}
            >
              开始读取{plan.count ? ` ${plan.count} 张` : ''}
            </button>
          </section>
        )}
        {job && job.failed > 0 && (
          <section className="gps-failures" aria-label="失败照片">
            <h3>失败照片（{job.failed}）</h3>
            {job.failures.map((failure) => (
              <div className="gps-failure" key={failure.id}>
                <div>
                  <strong>{failure.filename}</strong>
                  <p>{failure.message}</p>
                  <small>已尝试 {failure.tries} 次</small>
                </div>
                <button
                  disabled={!retryable || busy}
                  onClick={() => void command('retry', [failure.id])}
                >
                  重试这张
                </button>
              </div>
            ))}
            {job.nextFailure && (
              <button disabled={working || busy} onClick={() => void moreFailures()}>
                加载更多失败照片
              </button>
            )}
          </section>
        )}
      </div>
      <footer className="modal-actions">
        <button disabled={busy || working} onClick={() => void load()}>
          刷新进度
        </button>
        <button
          disabled={busy}
          onClick={() => {
            stopLocal();
            latestUpdated.current();
            close();
          }}
        >
          关闭
        </button>
      </footer>
    </Modal>
  );
}
