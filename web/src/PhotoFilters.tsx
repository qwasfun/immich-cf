import { useEffect, useId, useState } from 'react';
import { emptyPhotoQuery, photoQuery, photoQueryParams } from '../../src/web/gallery-query';
import type { PhotoQuery } from '../../src/web/gallery-query';
import { ErrorBox, Icon } from './ui';

function dateInput(iso: string, end = false) {
  if (!iso) return '';
  const date = new Date(Date.parse(iso) - (end ? 1 : 0));
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function draftOf(query: PhotoQuery) {
  return { ...query, from: dateInput(query.from), to: dateInput(query.to, true) };
}

function localDate(value: string, label: string) {
  const parsed = new Date(`${value}T00:00:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.getFullYear() !== Number(value.slice(0, 4)) ||
    parsed.getMonth() + 1 !== Number(value.slice(5, 7)) ||
    parsed.getDate() !== Number(value.slice(8, 10))
  )
    throw new Error(`${label}：请选择有效的日期`);
  return parsed;
}

export function PhotoFilters({
  apply,
  disabled = false,
  trash = false,
  initialQuery,
}: {
  apply: (query: PhotoQuery) => void;
  disabled?: boolean;
  trash?: boolean;
  initialQuery?: PhotoQuery;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => draftOf(initialQuery ?? emptyPhotoQuery));
  useEffect(() => {
    if (initialQuery) setDraft(draftOf(initialQuery));
  }, [initialQuery]);
  return (
    <form
      className="photo-filters"
      aria-label="查找照片"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget),
          q = String(data.get('q') ?? ''),
          from = String(data.get('from') ?? ''),
          to = String(data.get('to') ?? ''),
          type = String(data.get('type') ?? 'all'),
          order = String(data.get('order') ?? 'newest');
        setError('');
        try {
          for (const [name, label] of [
            ['from', '拍摄开始日期'],
            ['to', '拍摄结束日期'],
          ]) {
            const input = event.currentTarget.elements.namedItem(name!) as HTMLInputElement;
            if (input.validity.badInput) throw new Error(`${label}：请填写完整、有效的日期`);
          }
          if (from && to && from > to)
            throw new Error('拍摄开始日期、拍摄结束日期：开始日期不能晚于结束日期，请调整日期范围');
          const end = to ? localDate(to, '拍摄结束日期') : null;
          end?.setDate(end.getDate() + 1);
          const query = photoQuery(
            photoQueryParams({
              q,
              from: from ? localDate(from, '拍摄开始日期').toISOString() : '',
              to: end?.toISOString() ?? '',
              type,
              order,
            }),
          );
          apply(query);
        } catch (e) {
          setError((e as Error).message);
        }
      }}
      onReset={(event) => {
        event.preventDefault();
        setError('');
        setDraft(draftOf(emptyPhotoQuery));
        apply({ ...emptyPhotoQuery });
      }}
    >
      <fieldset disabled={disabled}>
        <legend className="sr-only">搜索和筛选照片</legend>
        <label className="field filter-name" htmlFor={`${id}-q`}>
          文件名
          <input
            id={`${id}-q`}
            name="q"
            type="search"
            placeholder="输入文件名搜索整个列表"
            maxLength={100}
            value={draft.q}
            onChange={(event) => setDraft({ ...draft, q: event.target.value })}
          />
        </label>
        <label className="field" htmlFor={`${id}-from`}>
          拍摄开始日期
          <input
            id={`${id}-from`}
            name="from"
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label className="field" htmlFor={`${id}-to`}>
          拍摄结束日期
          <input
            id={`${id}-to`}
            name="to"
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <label className="field" htmlFor={`${id}-type`}>
          照片类型
          <select
            id={`${id}-type`}
            name="type"
            value={draft.type}
            onChange={(event) => setDraft({ ...draft, type: event.target.value })}
          >
            <option value="all">全部类型</option>
            <option value="static">静态照片</option>
            <option value="live">动态照片（Live Photo）</option>
            <option value="jpeg">JPEG</option>
            <option value="png">PNG</option>
            <option value="heic">HEIC</option>
          </select>
        </label>
        <label className="field" htmlFor={`${id}-order`}>
          排序{trash ? '（删除时间）' : '（拍摄时间）'}
          <select
            id={`${id}-order`}
            name="order"
            value={draft.order}
            onChange={(event) => setDraft({ ...draft, order: event.target.value })}
          >
            <option value="newest">最新在前</option>
            <option value="oldest">最早在前</option>
          </select>
        </label>
        <div className="filter-actions">
          <button className="primary" type="submit">
            <Icon name="search" size={16} />
            查找
          </button>
          <button type="reset">重置</button>
        </div>
      </fieldset>
      <p className="fine-print">
        搜索覆盖当前列表的全部照片；日期按本机时区筛选，包含结束日期当天。
      </p>
      <ErrorBox error={error} />
    </form>
  );
}
