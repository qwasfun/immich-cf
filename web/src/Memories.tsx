import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { memoryDate } from '../../src/memory-date';
import { api, web } from './api';
import { Gallery } from './Gallery';
import { Empty, ErrorBox, Icon, Preview } from './ui';

interface Overview {
  date: string;
  timeZone: string;
  version: string;
  total: number;
  years: { year: number; yearsAgo: number; count: number; coverId: string }[];
}
const localToday = () => {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
function relativeDay(date: string, days: number) {
  return new Date(Date.parse(date + 'T00:00:00.000Z') + days * 86400000).toISOString().slice(0, 10);
}

export function Memories({
  referenceDate,
  year,
  refresh,
  changed,
  navigate,
  ownerId,
  entryKey,
}: {
  referenceDate?: string;
  year?: number;
  refresh: number;
  changed: (message: string) => void;
  navigate: (path: string) => void;
  ownerId: string;
  entryKey: string;
}) {
  const [today, setToday] = useState(localToday);
  const date = referenceDate ?? today;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [draft, setDraft] = useState(date),
    [formError, setFormError] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  let valid = true;
  try {
    memoryDate(date);
  } catch {
    valid = false;
  }
  useEffect(() => {
    const update = () => setToday(localToday());
    const timer = window.setInterval(update, 60000);
    window.addEventListener('focus', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, []);
  useEffect(() => {
    setDraft(date);
  }, [date]);
  useEffect(() => {
    if (year) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ memoryDate: date, timeZone });
    api<Overview>(`${web}/memories?${params}`, 'GET', undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setOverview(result);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [date, timeZone, year, refresh, retry]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const next = memoryDate(draft);
      if (next > today) throw new Error('回忆日期：不能晚于当地今天，请选择今天或之前的日期');
      setFormError('');
      navigate('/memories/' + next);
    } catch (e) {
      setFormError((e as Error).message);
    }
  }
  if (year)
    return (
      <>
        <button className="memory-back" onClick={() => navigate('/memories/' + date)}>
          <Icon name="left" />
          返回往年今日
        </button>
        <Gallery
          key={date + ':' + year + ':' + timeZone}
          view="memories"
          memory={{ date, year, timeZone }}
          refresh={refresh}
          changed={changed}
          ownerId={ownerId}
          entryKey={entryKey}
        />
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ON THIS DAY</p>
          <h1>往年今日</h1>
          <p className="muted">重温往年同一天，看看这些年留下的瞬间。</p>
        </div>
      </div>
      <section className="panel memory-controls" aria-label="选择回忆日期">
        <form onSubmit={submit} noValidate>
          <label className="field">
            回忆日期
            <input
              aria-label="回忆日期"
              type="date"
              min="0001-01-01"
              max={today}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button className="primary">查看这一天</button>
          <button type="button" disabled={date === today} onClick={() => navigate('/memories')}>
            回到今天
          </button>
        </form>
        <div className="memory-days">
          <button
            disabled={!valid || date <= '0001-01-01'}
            onClick={() => navigate('/memories/' + relativeDay(date, -1))}
          >
            <Icon name="left" size={16} />
            前一天
          </button>
          <strong>
            {valid ? `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8))} 日` : '请选择日期'}
          </strong>
          <button
            disabled={!valid || date >= today}
            onClick={() => navigate('/memories/' + relativeDay(date, 1))}
          >
            后一天
            <Icon name="right" size={16} />
          </button>
        </div>
        <ErrorBox error={formError} />
        <p className="fine-print">
          按当前时区 {timeZone} 的拍摄日期汇总，仅显示所选日期之前各年的照片；归档、回收站与配套 MOV
          不单独进入回忆。2 月 29 日仅匹配闰年的这一天。
        </p>
      </section>
      <ErrorBox error={error} retry={() => setRetry((value) => value + 1)} />
      {loading && (
        <p role="status" className="muted">
          正在寻找这一天的回忆…
        </p>
      )}
      {overview && overview.date === date && (
        <>
          <p className="memory-summary" role="status">
            {overview.years.length} 个年份 · {overview.total.toLocaleString()} 张照片
          </p>
          <div className="memory-grid">
            {overview.years.map((group) => (
              <a
                className="memory-card"
                key={group.year}
                href={`/memories/${date}/${group.year}`}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(`/memories/${date}/${group.year}`);
                }}
              >
                <div className="memory-cover">
                  <Preview id={group.coverId} name={`${group.year} 年的这一天`} />
                  <span>{group.yearsAgo} 年前</span>
                </div>
                <div className="memory-card-copy">
                  <div>
                    <h2>{group.year} 年</h2>
                    <p className="muted">{group.count.toLocaleString()} 张照片</p>
                  </div>
                  <Icon name="right" />
                </div>
              </a>
            ))}
          </div>
          {!loading && !error && overview.total === 0 && (
            <Empty title="这一天还没有往年照片">试着选择其他日期，或通过上传补充过去的照片。</Empty>
          )}
        </>
      )}
    </>
  );
}
