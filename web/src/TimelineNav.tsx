import { useEffect, useId, useState } from 'react';
import type { Month } from './useTimeline';
import { Modal } from './ui';

export function TimelineNav({
  months,
  active,
  jump,
  disabled,
}: {
  months: Month[];
  active: string;
  jump: (month: Month) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activeYear = Number((active || months[0]?.key || '').slice(0, 4));
  const [year, setYear] = useState(activeYear);
  const years = [...new Set(months.map((month) => month.year))];
  const id = useId();
  useEffect(() => {
    setYear(activeYear);
  }, [activeYear]);
  const shownYear = years.includes(year) ? year : years[0];
  function navigation(mobile: boolean) {
    return (
      <nav aria-label={mobile ? '选择年月' : '年月导航'}>
        <label htmlFor={id + (mobile ? '-mobile' : '')} className="sr-only">
          年份
        </label>
        <select
          id={id + (mobile ? '-mobile' : '')}
          value={shownYear}
          onChange={(event) => setYear(Number(event.target.value))}
        >
          {years.map((value) => (
            <option key={value} value={value}>
              {value}年
            </option>
          ))}
        </select>
        <div className="timeline-months">
          {months
            .filter((month) => month.year === shownYear)
            .map((month) => (
              <button
                key={month.key}
                disabled={disabled}
                aria-current={active === month.key ? 'date' : undefined}
                aria-label={`跳转到${month.year}年${month.month}月（${month.count}张）`}
                onClick={() => {
                  jump(month);
                  setOpen(false);
                }}
              >
                <span>{month.month}月</span>
                <small>{month.count.toLocaleString()}张</small>
              </button>
            ))}
        </div>
      </nav>
    );
  }
  if (!months.length) return null;
  return (
    <>
      <aside className="timeline-rail">{navigation(false)}</aside>
      <button className="timeline-date-trigger" onClick={() => setOpen(true)} disabled={disabled}>
        跳转日期
      </button>
      {open && (
        <Modal title="跳转日期" close={() => setOpen(false)}>
          <div className="form-body timeline-date-panel">{navigation(true)}</div>
        </Modal>
      )}
    </>
  );
}
