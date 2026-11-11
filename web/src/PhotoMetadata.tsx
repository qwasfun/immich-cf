import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, date, web } from './api';
import { ErrorBox, Modal } from './ui';
import { photoWallTime, resolvePhotoTime } from '../../src/photo-time';
import type { PhotoMetadataData } from '../../src/photo-info';

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const occurrenceAt = (instant: string, zone: string): 'earlier' | 'later' =>
  Date.parse(resolvePhotoTime(photoWallTime(instant, zone), zone).time) === Date.parse(instant)
    ? 'earlier'
    : 'later';
const sourceName = {
  submitted: '上传时提供的时间',
  file: '文件修改时间',
  exif: '原件 EXIF',
  manual: '手动修正',
};
async function readDetails(id: string, extract: boolean, signal: AbortSignal) {
  const data = await api<PhotoMetadataData>(
    `${web}/assets/${id}/metadata`,
    'GET',
    undefined,
    signal,
  );
  if (extract && !data.extracted && !data.isTrashed) {
    try {
      return {
        data: await api<PhotoMetadataData>(
          `${web}/assets/${id}/metadata/extract`,
          'POST',
          { version: data.version },
          signal,
        ),
        error: '',
      };
    } catch (e) {
      if (signal.aborted) throw e;
      return { data, error: (e as Error).message };
    }
  }
  return { data, error: '' };
}
function useDetails(id: string, extract = true) {
  const [data, setData] = useState<PhotoMetadataData | null>(null),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const control = new AbortController();
    setData(null);
    setError('');
    void readDetails(id, extract, control.signal)
      .then((result) => {
        if (!control.signal.aborted) {
          setData(result.data);
          setError(result.error);
        }
      })
      .catch((e) => {
        if (!control.signal.aborted) setError((e as Error).message);
      });
    return () => control.abort();
  }, [id, extract, refresh]);
  return { data, error, retry: () => setRefresh((v) => v + 1) };
}
export function PhotoMetadataInfo({ id }: { id: string }) {
  const { data, error, retry } = useDetails(id);
  return (
    <div className="photo-metadata-info">
      {!data && !error && <p role="status">正在读取照片资料…</p>}
      <ErrorBox error={error} retry={retry} />
      {data && (
        <>
          <dl>
            <dt>时间来源 / 拍摄时区</dt>
            <dd>
              {sourceName[data.timeSource]} · {data.timeZone || '未注明'}
            </dd>
            <dt>照片描述</dt>
            <dd className="metadata-description">{data.description || '未填写'}</dd>
            <dt>相机</dt>
            <dd>{[data.make, data.model].filter(Boolean).join(' ') || '原件未提供'}</dd>
            <dt>镜头</dt>
            <dd>{data.lensModel || '原件未提供'}</dd>
            <dt>拍摄参数</dt>
            <dd>
              {[
                data.fNumber ? `f/${data.fNumber}` : null,
                data.exposureTime ? `${data.exposureTime} 秒` : null,
                data.iso ? `ISO ${data.iso}` : null,
                data.focalLength ? `${data.focalLength} mm` : null,
              ]
                .filter(Boolean)
                .join(' · ') || '原件未提供'}
            </dd>
            <dt>GPS 纬度 / 经度</dt>
            <dd>
              {data.latitude !== null && data.longitude !== null
                ? `${data.latitude}, ${data.longitude}`
                : '未提供位置'}
            </dd>
            {data.source.originalDateTime && (
              <>
                <dt>原件拍摄时间</dt>
                <dd>
                  {data.source.originalDateTime.replace('T', ' ')}{' '}
                  {data.source.originalOffset || '（未注明时区）'}
                </dd>
              </>
            )}
          </dl>
          {data.source.warning && <p className="fine-print">{data.source.warning}</p>}
        </>
      )}
    </div>
  );
}
function TimeFields({
  local,
  setLocal,
  zone,
  setZone,
  occurrence,
  setOccurrence,
  disabled = false,
}: {
  local: string;
  setLocal: (v: string) => void;
  zone: string;
  setZone: (v: string) => void;
  occurrence: 'earlier' | 'later';
  setOccurrence: (v: 'earlier' | 'later') => void;
  disabled?: boolean;
}) {
  let preview = '';
  try {
    const resolved = resolvePhotoTime(local, zone, occurrence);
    preview = `对应 UTC：${resolved.time}${resolved.ambiguous ? '（所选当地时间出现两次）' : ''}`;
  } catch (e) {
    if (local) preview = (e as Error).message;
  }
  return (
    <fieldset className="metadata-time-fields" disabled={disabled}>
      <div className="metadata-grid">
        <label className="field">
          当地拍摄时间
          <input
            type="datetime-local"
            name="dateTime"
            step="0.001"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
          />
        </label>
        <label className="field">
          拍摄时区
          <input
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            placeholder="Asia/Shanghai 或 +08:00"
            maxLength={100}
          />
          <small>IANA 时区或原件 UTC 偏移</small>
        </label>
      </div>
      <label className="field">
        夏令时重复时刻
        <select
          value={occurrence}
          onChange={(e) => setOccurrence(e.target.value as 'earlier' | 'later')}
        >
          <option value="earlier">第一次出现的时间</option>
          <option value="later">第二次出现的时间</option>
        </select>
      </label>
      {preview && (
        <p className="fine-print" role="status">
          {preview}
        </p>
      )}
    </fieldset>
  );
}
export function EditPhotoMetadata({
  id,
  close,
  changed,
}: {
  id: string;
  close: () => void;
  changed: (text: string) => void;
}) {
  const { data, error: loadError, retry } = useDetails(id);
  const [description, setDescription] = useState(''),
    [latitude, setLatitude] = useState(''),
    [longitude, setLongitude] = useState('');
  const [local, setLocal] = useState(''),
    [zone, setZone] = useState(browserZone),
    [occurrence, setOccurrence] = useState<'earlier' | 'later'>('earlier'),
    [correctTime, setCorrectTime] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) {
      setDescription(data.description ?? '');
      setLatitude(data.latitude === null ? '' : String(data.latitude));
      setLongitude(data.longitude === null ? '' : String(data.longitude));
      const selectedZone = data.timeZone || browserZone();
      setZone(selectedZone);
      setLocal(photoWallTime(data.fileCreatedAt, selectedZone));
      setOccurrence(occurrenceAt(data.fileCreatedAt, selectedZone));
    }
  }, [data]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    setError('');
    try {
      const patch: Record<string, unknown> = { ids: [id], version: data.version };
      for (const [name, label] of [
        ['latitude', '纬度'],
        ['longitude', '经度'],
        ['dateTime', '拍摄时间'],
      ]) {
        const input = event.currentTarget.elements.namedItem(name!) as HTMLInputElement | null;
        if (input?.validity.badInput)
          throw Error(`${label}：请填写完整、有效的${name === 'dateTime' ? '日期时间' : '数字'}`);
      }
      if (description !== (data.description ?? '')) {
        if (description.length > 2000) throw Error('照片描述：最多 2000 个字符，请缩短内容');
        patch.description = description;
      }
      const lat = latitude.trim(),
        lon = longitude.trim();
      if (!!lat !== !!lon) throw Error('纬度、经度：请同时填写两项，或同时清空以移除位置');
      const nextLat = lat ? Number(lat) : null,
        nextLon = lon ? Number(lon) : null;
      if (nextLat !== null && (!Number.isFinite(nextLat) || Math.abs(nextLat) > 90))
        throw Error('纬度：请填写 -90～90 的有限数字，或清空位置');
      if (nextLon !== null && (!Number.isFinite(nextLon) || Math.abs(nextLon) > 180))
        throw Error('经度：请填写 -180～180 的有限数字，或清空位置');
      if (nextLat !== data.latitude || nextLon !== data.longitude) {
        patch.latitude = nextLat;
        patch.longitude = nextLon;
      }
      if (correctTime) {
        resolvePhotoTime(local, zone, occurrence);
        Object.assign(patch, { dateTime: local, timeZone: zone, occurrence });
      }
      if (Object.keys(patch).length === 2) throw Error('照片资料：请至少修改一项内容后保存');
      setBusy(true);
      await api(`${web}/photo-metadata`, 'PATCH', patch);
      changed('照片资料已更新');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="编辑照片资料" close={close} busy={busy}>
      <form className="photo-metadata-form" onSubmit={submit} noValidate>
        <div className="form-body">
          <ErrorBox error={loadError} retry={retry} />
          {!data && !loadError && <p role="status">正在读取照片资料…</p>}
          {data && (
            <>
              <p className="fine-print">
                修改保存到图库资料，原件字节保持不变。当前拍摄时间：{date(data.fileCreatedAt)}。
              </p>
              <label className="field">
                照片描述
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={busy}
                />
              </label>
              <div className="metadata-grid">
                <label className="field">
                  纬度
                  <input
                    type="number"
                    name="latitude"
                    step="any"
                    min={-90}
                    max={90}
                    value={latitude}
                    onChange={(e) => setLatitude(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  经度
                  <input
                    type="number"
                    name="longitude"
                    step="any"
                    min={-180}
                    max={180}
                    value={longitude}
                    onChange={(e) => setLongitude(e.target.value)}
                    disabled={busy}
                  />
                </label>
              </div>
              <p className="fine-print">
                同时清空纬度和经度可移除图库中的位置；下载原件仍保留其原有 EXIF。
              </p>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={correctTime}
                  onChange={(e) => setCorrectTime(e.target.checked)}
                  disabled={busy}
                />
                修正拍摄时间
              </label>
              {correctTime && (
                <TimeFields
                  local={local}
                  setLocal={setLocal}
                  zone={zone}
                  setZone={setZone}
                  occurrence={occurrence}
                  setOccurrence={setOccurrence}
                  disabled={busy}
                />
              )}
              {data.source.originalDateTime && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setLocal(data.source.originalDateTime!);
                    setZone(data.source.originalOffset || data.timeZone || browserZone());
                    setCorrectTime(true);
                  }}
                >
                  采用原件拍摄时间
                </button>
              )}
              {data.source.warning && <p className="fine-print">{data.source.warning}</p>}
            </>
          )}
          <ErrorBox error={error} />
        </div>
        <footer className="modal-actions">
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !data}>
            {busy ? '正在保存…' : '保存资料'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function CorrectPhotoTime({
  ids,
  close,
  changed,
}: {
  ids: string[];
  close: () => void;
  changed: (text: string) => void;
}) {
  const { data, error: loadError, retry } = useDetails(ids[0]!, false);
  const [mode, setMode] = useState('shift'),
    [minutes, setMinutes] = useState(''),
    [local, setLocal] = useState(''),
    [zone, setZone] = useState(browserZone),
    [occurrence, setOccurrence] = useState<'earlier' | 'later'>('earlier');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) {
      const z = data.timeZone || browserZone();
      setZone(z);
      setLocal(photoWallTime(data.fileCreatedAt, z));
      setOccurrence(occurrenceAt(data.fileCreatedAt, z));
    }
  }, [data]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    setError('');
    try {
      const patch: Record<string, unknown> = { ids, version: data.version };
      if (mode === 'shift') {
        const shift = Number(minutes);
        if (!minutes.trim() || !Number.isSafeInteger(shift) || !shift || Math.abs(shift) > 52596000)
          throw Error('整体偏移：请填写非零整数分钟，范围为 -52,596,000～52,596,000');
        patch.shiftMinutes = shift;
      } else {
        resolvePhotoTime(local, zone, occurrence);
        Object.assign(patch, { dateTime: local, timeZone: zone, occurrence });
      }
      setBusy(true);
      await api(`${web}/photo-metadata`, 'PATCH', patch);
      changed(`已修正 ${ids.length} 张照片的拍摄时间`);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const sample =
    data && minutes.trim() && Number.isFinite(Number(minutes))
      ? new Date(Date.parse(data.fileCreatedAt) + Number(minutes) * 60000)
      : null;
  return (
    <Modal title="批量修正拍摄时间" close={close} busy={busy}>
      <form className="photo-metadata-form" onSubmit={submit} noValidate>
        <div className="form-body">
          <p>将修改所选 {ids.length} 张照片的图库拍摄时间，原件保持不变。</p>
          <ErrorBox error={loadError} retry={retry} />
          {!data && !loadError && <p role="status">正在读取所选照片资料…</p>}
          <label className="field">
            修正方式
            <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={busy || !data}>
              <option value="shift">整体前移 / 后移，保留照片间隔</option>
              <option value="set">设置为相同拍摄时间</option>
            </select>
          </label>
          {mode === 'shift' ? (
            <>
              <label className="field">
                整体偏移（分钟）
                <input
                  type="number"
                  step={1}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  placeholder="如 -480 表示前移 8 小时"
                  disabled={busy || !data}
                />
                <small>负数前移，正数后移。保留各照片的拍摄时区。</small>
              </label>
              {data && (
                <p className="fine-print">
                  示例照片：{date(data.fileCreatedAt)}
                  {sample && Number.isFinite(sample.getTime())
                    ? ' → ' + date(sample.toISOString())
                    : ''}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="fine-print">全部所选照片将使用相同拍摄时刻；不保留原来的时间间隔。</p>
              <TimeFields
                local={local}
                setLocal={setLocal}
                zone={zone}
                setZone={setZone}
                occurrence={occurrence}
                setOccurrence={setOccurrence}
                disabled={busy || !data}
              />
            </>
          )}
          <ErrorBox error={error} />
        </div>
        <footer className="modal-actions">
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !data}>
            {busy ? '正在保存…' : '应用时间修正'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
