export const ARCHIVE_BYTES = 1024 ** 3;
export const ARCHIVE_FILES = 1000;
export const DOWNLOAD_TTL = 24 * 60 * 60 * 1000;
export interface ArchiveEntry {
  id: string;
  name: string;
  size: number;
  modified: string;
}
export interface ArchivePart {
  entries: ArchiveEntry[];
  photos: number;
  bytes: number;
}

function truncate(value: string, max = 160) {
  const encoder = new TextEncoder();
  while (encoder.encode(value).length > max) value = Array.from(value).slice(0, -1).join('');
  return value;
}
export function safeArchiveName(value: string) {
  let result = value
    .normalize('NFC')
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!result) result = '照片';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = '_' + result;
  return truncate(result);
}
export class ArchivePlanner {
  readonly parts: ArchivePart[] = [];
  private used = new Set<string>();
  add(photo: {
    id: string;
    filename: string;
    mime: string;
    bytes: number;
    modified: string;
    motionId: string | null;
    motionBytes: number;
  }) {
    const original = safeArchiveName(photo.filename),
      ext =
        /\.(jpe?g|png|heic|heif)$/i.exec(original)?.[1] ??
        (photo.mime === 'image/png' ? 'png' : photo.mime === 'image/heic' ? 'heic' : 'jpg'),
      base = original.replace(/\.(jpe?g|png|heic|heif)$/i, '');
    let suffix = 1,
      name: string,
      motionName: string;
    do {
      const stem = truncate(base, 140) + (suffix === 1 ? '' : ` (${suffix})`);
      name = `${stem}.${ext}`;
      motionName = `${stem}.mov`;
      suffix++;
    } while (
      this.used.has(name.toLowerCase()) ||
      (photo.motionId && this.used.has(motionName.toLowerCase()))
    );
    this.used.add(name.toLowerCase());
    const entries: ArchiveEntry[] = [
      { id: photo.id, name, size: photo.bytes, modified: photo.modified },
    ];
    if (photo.motionId) {
      this.used.add(motionName.toLowerCase());
      entries.push({
        id: photo.motionId,
        name: motionName,
        size: photo.motionBytes,
        modified: photo.modified,
      });
    }
    const bytes = photo.bytes + (photo.motionId ? photo.motionBytes : 0);
    let part = this.parts.at(-1);
    if (
      !part ||
      part.bytes + bytes > ARCHIVE_BYTES ||
      part.entries.length + entries.length > ARCHIVE_FILES
    ) {
      part = { entries: [], photos: 0, bytes: 0 };
      this.parts.push(part);
    }
    part.entries.push(...entries);
    part.photos++;
    part.bytes += bytes;
  }
}
