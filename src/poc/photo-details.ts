import type { Asset } from './assets';
import type { PhotoExif } from './photo-exif';
import { photoWallTime, resolvePhotoTime } from '../photo-time';

export interface PhotoRecord {
  extracted: boolean;
  source: PhotoExif;
  overrides: { description?: string; latitude?: number | null; longitude?: number | null };
  timeZone: string | null;
  timeSource: 'submitted' | 'file' | 'exif' | 'manual';
}
export function photoRecord(row: { photo_metadata?: string }): PhotoRecord {
  const stored = JSON.parse(row.photo_metadata || '{}');
  return {
    extracted: false,
    source: {},
    overrides: {},
    timeZone: null,
    timeSource: 'submitted',
    ...stored,
  };
}
export function initialPhotoRecord(source: PhotoExif, submitted: string, webZone?: string) {
  const record: PhotoRecord = {
    extracted: true,
    source,
    overrides: {},
    timeZone: source.originalOffset ?? webZone ?? null,
    timeSource: webZone ? 'file' : 'submitted',
  };
  let time = submitted;
  if (webZone && source.originalDateTime) {
    try {
      const resolved = resolvePhotoTime(source.originalDateTime, source.originalOffset ?? webZone);
      time = resolved.time;
      record.timeZone = resolved.zone;
      record.timeSource = 'exif';
    } catch {
      record.source.warning =
        '原件拍摄时间无法按所选时区确定，暂采用文件修改时间，可在照片资料中修正';
    }
  }
  return {
    record,
    time,
    local: record.timeZone ? photoWallTime(time, record.timeZone) + 'Z' : time,
  };
}
export function photoExifDto(row: Asset) {
  const record = photoRecord(row),
    source = record.source,
    edits = record.overrides;
  return {
    city: null,
    country: null,
    state: null,
    dateTimeOriginal: row.file_created_at,
    modifyDate: row.file_modified_at,
    description: edits.description ?? source.description ?? null,
    exifImageHeight: row.height,
    exifImageWidth: row.width,
    fileSizeInByte: row.bytes,
    exposureTime: source.exposureTime ?? null,
    fNumber: source.fNumber ?? null,
    focalLength: source.focalLength ?? null,
    iso: source.iso ?? null,
    latitude: Object.hasOwn(edits, 'latitude') ? edits.latitude! : (source.latitude ?? null),
    longitude: Object.hasOwn(edits, 'longitude') ? edits.longitude! : (source.longitude ?? null),
    lensModel: source.lensModel ?? null,
    make: source.make ?? null,
    model: source.model ?? null,
    orientation: source.orientation ?? null,
    projectionType: null,
    rating: row.rating ?? null,
    timeZone: record.timeZone,
  };
}
