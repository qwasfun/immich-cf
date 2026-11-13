import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  emptyPhotoQuery,
  hasPhotoFilters,
  photoQuery,
  photoQueryParams,
} from '../../src/web/gallery-query';
import type { PhotoQuery } from '../../src/web/gallery-query';
import { ErrorBox, Icon } from './ui';
import { TagSuggestions } from './PhotoLabels';

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

const typeLabels: Record<string, string> = {
  static: '静态照片',
  live: '动态照片',
  jpeg: 'JPEG',
  png: 'PNG',
  heic: 'HEIC',
};

function ratingLabel(rating: string) {
  if (rating === 'none') return '未评分';
  if (rating.startsWith('gte')) return `${rating.slice(3)} 星及以上`;
  return `仅 ${rating} 星`;
}

export function PhotoFilters({
  apply,
  disabled = false,
  trash = false,
  initialQuery,
  extraActions,
}: {
  apply: (query: PhotoQuery) => void;
  disabled?: boolean;
  trash?: boolean;
  initialQuery?: PhotoQuery;
  extraActions?: ReactNode;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => draftOf(initialQuery ?? emptyPhotoQuery));
  const hasAdvanced = Boolean(
    draft.from || draft.to || draft.type !== 'all' || draft.tag || draft.rating !== 'all',
  );
  const [expanded, setExpanded] = useState(hasAdvanced);

  useEffect(() => {
    if (initialQuery) {
      const next = draftOf(initialQuery);
      setDraft(next);
      if (next.from || next.to || next.type !== 'all' || next.tag || next.rating !== 'all') {
        setExpanded(true);
      }
    }
  }, [initialQuery]);

  const activeAdvancedCount = [
    draft.from || draft.to ? 1 : 0,
    draft.type !== 'all' ? 1 : 0,
    draft.tag ? 1 : 0,
    draft.rating !== 'all' ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  const isFiltered = initialQuery ? hasPhotoFilters(initialQuery) : hasPhotoFilters(draft);

  function submitDraft(nextDraft: typeof draft) {
    setError('');
    try {
      if (nextDraft.from && nextDraft.to && nextDraft.from > nextDraft.to)
        throw new Error('拍摄开始日期、拍摄结束日期：开始日期不能晚于结束日期，请调整日期范围');
      const end = nextDraft.to ? localDate(nextDraft.to, '拍摄结束日期') : null;
      end?.setDate(end.getDate() + 1);
      const query = photoQuery(
        photoQueryParams({
          q: nextDraft.q,
          from: nextDraft.from ? localDate(nextDraft.from, '拍摄开始日期').toISOString() : '',
          to: end?.toISOString() ?? '',
          type: nextDraft.type,
          order: nextDraft.order,
          tag: nextDraft.tag,
          rating: nextDraft.rating,
        }),
      );
      apply(query);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form
      className={`photo-filters ${expanded ? 'is-expanded' : 'is-compact'}`}
      aria-label="查找照片"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget),
          q = String(data.get('q') ?? ''),
          from = String(data.get('from') ?? ''),
          to = String(data.get('to') ?? ''),
          type = String(data.get('type') ?? 'all'),
          tag = String(data.get('tag') ?? ''),
          rating = String(data.get('rating') ?? 'all'),
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
              tag,
              rating,
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
        <div className="filter-compact-bar">
          <label className="field filter-name" htmlFor={`${id}-q`}>
            <span className="sr-only">文件名</span>
            <div className="search-input-wrap">
              <Icon name="search" size={16} />
              <input
                id={`${id}-q`}
                name="q"
                type="search"
                placeholder="搜索文件名（按 / 聚焦）…"
                maxLength={100}
                value={draft.q}
                onChange={(event) => setDraft({ ...draft, q: event.target.value })}
              />
            </div>
          </label>
          <label className="field filter-order-inline" htmlFor={`${id}-order`}>
            <span className="sr-only">排序{trash ? '（删除时间）' : '（拍摄时间）'}</span>
            <select
              id={`${id}-order`}
              name="order"
              aria-label={`排序${trash ? '（删除时间）' : '（拍摄时间）'}`}
              value={draft.order}
              onChange={(event) => {
                const next = {
                  ...draft,
                  order: event.target.value as PhotoQuery['order'],
                };
                setDraft(next);
                submitDraft(next);
              }}
            >
              <option value="newest">最新在前</option>
              <option value="oldest">最早在前</option>
            </select>
          </label>
          <button
            type="button"
            className={`filter-toggle-btn ${expanded || activeAdvancedCount > 0 ? 'active' : ''}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name="filter" size={16} />
            <span>筛选</span>
            {activeAdvancedCount > 0 && <span className="filter-badge">{activeAdvancedCount}</span>}
          </button>
          <div className="filter-actions">
            <button className="primary" type="submit">
              <Icon name="search" size={15} />
              查找
            </button>
            <button
              type="reset"
              className={!isFiltered && !draft.q && !activeAdvancedCount ? 'subtle-reset' : ''}
            >
              重置
            </button>
          </div>
          {extraActions && <div className="filter-extra-actions">{extraActions}</div>}
        </div>

        {(draft.q || activeAdvancedCount > 0) && !expanded && (
          <div className="active-filter-pills" aria-label="当前筛选条件">
            {draft.q && (
              <button
                type="button"
                className="filter-pill"
                onClick={() => {
                  const next = { ...draft, q: '' };
                  setDraft(next);
                  submitDraft(next);
                }}
              >
                文件名：{draft.q} ×
              </button>
            )}
            {(draft.from || draft.to) && (
              <button
                type="button"
                className="filter-pill"
                onClick={() => {
                  const next = { ...draft, from: '', to: '' };
                  setDraft(next);
                  submitDraft(next);
                }}
              >
                日期：{draft.from || '最早'} 至 {draft.to || '最新'} ×
              </button>
            )}
            {draft.type !== 'all' && (
              <button
                type="button"
                className="filter-pill"
                onClick={() => {
                  const next = { ...draft, type: 'all' as const };
                  setDraft(next);
                  submitDraft(next);
                }}
              >
                类型：{typeLabels[draft.type] ?? draft.type} ×
              </button>
            )}
            {draft.tag && (
              <button
                type="button"
                className="filter-pill"
                onClick={() => {
                  const next = { ...draft, tag: '' };
                  setDraft(next);
                  submitDraft(next);
                }}
              >
                标签：{draft.tag} ×
              </button>
            )}
            {draft.rating !== 'all' && (
              <button
                type="button"
                className="filter-pill"
                onClick={() => {
                  const next = { ...draft, rating: 'all' as const };
                  setDraft(next);
                  submitDraft(next);
                }}
              >
                评分：{ratingLabel(draft.rating)} ×
              </button>
            )}
          </div>
        )}

        <div className={`filter-advanced-drawer ${expanded ? 'open' : ''}`}>
          <div className="filter-advanced-grid">
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
                onChange={(event) =>
                  setDraft({ ...draft, type: event.target.value as PhotoQuery['type'] })
                }
              >
                <option value="all">全部类型</option>
                <option value="static">静态照片</option>
                <option value="live">动态照片（Live Photo）</option>
                <option value="jpeg">JPEG</option>
                <option value="png">PNG</option>
                <option value="heic">HEIC</option>
              </select>
            </label>
            <label className="field" htmlFor={`${id}-tag`}>
              标签
              <input
                id={`${id}-tag`}
                name="tag"
                list={`${id}-tags`}
                value={draft.tag}
                maxLength={64}
                onChange={(e) => setDraft({ ...draft, tag: e.target.value })}
                placeholder="标签名称，精确匹配"
              />
              <TagSuggestions id={`${id}-tags`} query={draft.tag} />
            </label>
            <label className="field" htmlFor={`${id}-rating`}>
              评分筛选
              <select
                id={`${id}-rating`}
                name="rating"
                value={draft.rating}
                onChange={(e) =>
                  setDraft({ ...draft, rating: e.target.value as PhotoQuery['rating'] })
                }
              >
                <option value="all">全部评分</option>
                <option value="none">未评分</option>
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    仅 {value} 星
                  </option>
                ))}
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={'gte' + value} value={'gte' + value}>
                    {value} 星及以上
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="fine-print">
            搜索覆盖当前列表的全部照片；日期按本机时区筛选，包含结束日期当天。
          </p>
        </div>
      </fieldset>
      <ErrorBox error={error} />
    </form>
  );
}
