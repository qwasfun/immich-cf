import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, ApiError, web } from './api';
import { ErrorBox, Modal } from './ui';
import { photoTags, photoRating, tagName, tagKey } from '../../src/photo-labels';

export function TagSuggestions({ query, id }: { query: string; id: string }) {
  const [items, setItems] = useState<{ name: string; count: number }[]>([]),
    [more, setMore] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    if (Array.from(query).length > 32) {
      setItems([]);
      setMore(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void api<{ items: { name: string; count: number }[]; hasMore: boolean }>(
        `${web}/tags?q=${encodeURIComponent(query)}`,
        'GET',
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setItems(result.items);
            setMore(result.hasMore);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setItems([]);
            setMore(false);
          }
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return (
    <>
      <datalist id={id}>
        {items.map((item) => (
          <option key={item.name} value={item.name}>
            {item.count} 张照片
          </option>
        ))}
      </datalist>
      {more && <small>仅列出常用 50 项，继续输入可查找其他标签。</small>}
    </>
  );
}
interface LabelContext {
  version: string;
  count: number;
  commonTags: string[];
  rating: number | null;
  ratingMixed: boolean;
}
export function EditPhotoLabels({
  ids,
  close,
  changed,
}: {
  ids: string[];
  close: () => void;
  changed: (text: string) => void;
}) {
  const [data, setData] = useState<LabelContext | null>(null),
    [refresh, setRefresh] = useState(0),
    [tags, setTags] = useState<string[]>([]),
    [input, setInput] = useState(''),
    [action, setAction] = useState('add'),
    [rating, setRating] = useState('keep'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [review, setReview] = useState(false);
  const suggestions = useId();
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    setReview(false);
    void api<LabelContext>(`${web}/labels/inspect`, 'POST', { ids }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setTags(ids.length === 1 ? result.commonTags : []);
        setInput('');
        setAction(ids.length === 1 ? 'replace' : 'add');
        setRating(
          ids.length === 1 ? (result.rating === null ? 'none' : String(result.rating)) : 'keep',
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [refresh]);
  function withInput() {
    if (!input.trim()) return tags;
    const name = tagName(input);
    return photoTags(tags.some((other) => tagKey(other) === tagKey(name)) ? tags : [...tags, name]);
  }
  function add() {
    try {
      if (!input.trim()) throw Error('标签：请先填写 1～32 个字符的名称');
      setTags(withInput());
      setInput('');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!data || busy || review) return;
    setError('');
    let payload: Record<string, unknown>;
    try {
      const next = action === 'clear' ? [] : withInput();
      payload = { ids, version: data.version };
      if (action === 'clear' || action === 'replace' || next.length) {
        payload.tagAction = action;
        payload.tags = next;
      }
      if (rating !== 'keep')
        payload.rating = photoRating(rating === 'none' ? null : Number(rating));
      if (!('tagAction' in payload) && !('rating' in payload))
        throw Error('标签、评分：请至少填写标签或选择评分，再保存');
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ processed: number; changed: number; unchanged: number }>(
        `${web}/labels`,
        'PATCH',
        payload,
      );
      changed(
        `${result.changed} 张照片的标签与评分已更新${result.unchanged ? `；另有 ${result.unchanged} 张状态未变` : ''}`,
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
      title={ids.length === 1 ? '设置标签与评分' : '批量设置标签与评分'}
      close={close}
      drawer
      busy={busy}
    >
      <form className="photo-metadata-form photo-label-form" onSubmit={submit} noValidate>
        <div className="form-body">
          {!data && !error && <p role="status">正在读取所选照片的标签与评分…</p>}
          {data && (
            <>
              <p className="muted">已选 {data.count} 张照片 · 每张最多 20 个标签</p>
              {ids.length > 1 && (
                <p className="fine-print">
                  共有标签：{data.commonTags.join('、') || '无'}；评分：
                  {data.ratingMixed
                    ? '各不相同'
                    : data.rating === null
                      ? '未评分'
                      : `${data.rating} 星`}
                  。
                </p>
              )}
              <label className="field">
                标签操作
                <select value={action} disabled={busy} onChange={(e) => setAction(e.target.value)}>
                  <option value="add">追加标签，保留已有标签</option>
                  <option value="remove">移除指定标签</option>
                  <option value="replace">替换全部标签</option>
                  <option value="clear">清空全部标签</option>
                </select>
              </label>
              {(action === 'replace' || action === 'clear') && (
                <p className="notice">
                  {action === 'clear'
                    ? '将清空所选照片的全部标签。'
                    : '将用下面的标签替换所选照片原有标签；列表为空时会清空标签。'}
                </p>
              )}
              {action !== 'clear' && (
                <>
                  <div className="label-chips" aria-label="待设置标签">
                    {tags.map((tag) => (
                      <button
                        type="button"
                        key={tagKey(tag)}
                        disabled={busy}
                        onClick={() => setTags(tags.filter((name) => name !== tag))}
                        aria-label={`移除输入标签 ${tag}`}
                      >
                        {tag} ×
                      </button>
                    ))}
                  </div>
                  <label className="field">
                    新标签
                    <input
                      list={suggestions}
                      value={input}
                      disabled={busy}
                      maxLength={64}
                      placeholder="输入名称，按添加或回车确认"
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          add();
                        }
                      }}
                    />
                    <TagSuggestions query={input} id={suggestions} />
                    <small>每项 1～32 个字符，不含换行；保存时也会加入尚未确认的输入。</small>
                  </label>
                  <button type="button" disabled={busy} onClick={add}>
                    添加标签
                  </button>
                </>
              )}
              <div className="field label-rating">
                <label htmlFor={`${suggestions}-rating-select`}>评分</label>
                <div className="star-picker" role="group" aria-label="快捷选择星级">
                  {ids.length > 1 && (
                    <button
                      type="button"
                      className={`star-pill ${rating === 'keep' ? 'active' : ''}`}
                      disabled={busy}
                      onClick={() => setRating('keep')}
                    >
                      不修改
                    </button>
                  )}
                  <button
                    type="button"
                    className={`star-pill ${rating === 'none' ? 'active' : ''}`}
                    disabled={busy}
                    onClick={() => setRating('none')}
                  >
                    未评分
                  </button>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={`star-btn ${Number(rating) >= value ? 'filled' : ''} ${rating === String(value) ? 'active' : ''}`}
                      disabled={busy}
                      onClick={() => setRating(String(value))}
                      title={`${value} 星`}
                    >
                      ★ {value}
                    </button>
                  ))}
                </div>
                <select
                  id={`${suggestions}-rating-select`}
                  value={rating}
                  disabled={busy}
                  onChange={(e) => setRating(e.target.value)}
                >
                  <option value="keep">不修改评分</option>
                  <option value="none">清除评分（未评分）</option>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {value} 星
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <ErrorBox error={error} />
          {error && (
            <>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setRefresh((value) => value + 1)}
              >
                刷新并重新读取
              </button>
              <p className="fine-print">刷新会重置本窗口输入，请核对后再保存。</p>
            </>
          )}
        </div>
        <footer className="modal-actions">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={!data || busy || review}>
            {busy ? '正在保存…' : '保存标签与评分'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
