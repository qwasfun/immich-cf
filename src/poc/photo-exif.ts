import { localPhotoTime, photoTimeZone } from '../photo-time';
import type { PhotoExif } from '../photo-info';
export type { PhotoExif } from '../photo-info';

// Read only IFD0, ExifIFD and GPSIFD, with bounded values. Never traverse MakerNotes,
// thumbnails or arbitrary sub-IFDs. Unsupported descriptive tags do not reject an original.
export function photoExif(bytes: Uint8Array): PhotoExif {
  const result: PhotoExif = {};
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = bytes[0] === 73;
    const u16 = (at: number) => view.getUint16(at, little),
      u32 = (at: number) => view.getUint32(at, little);
    if (
      bytes.length < 8 ||
      !['II', 'MM'].includes(String.fromCharCode(bytes[0]!, bytes[1]!)) ||
      u16(2) !== 42
    )
      throw Error();
    const visited = new Set<number>();
    const table = (at: number) => {
      if (at < 8 || at > bytes.length - 2 || visited.has(at)) throw Error();
      visited.add(at);
      const count = u16(at),
        tags = new Map<number, number>();
      if (count > 512 || at + 2 + count * 12 + 4 > bytes.length) throw Error();
      for (let n = 0; n < count; n++) {
        const entry = at + 2 + n * 12,
          tag = u16(entry);
        if (tags.has(tag)) throw Error();
        tags.set(tag, entry);
      }
      return tags;
    };
    const data = (entry: number | undefined, types: number[], max = 256) => {
      if (entry === undefined) return null;
      const type = u16(entry + 2),
        count = u32(entry + 4),
        unit = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 } as Record<number, number>)[type];
      if (!types.includes(type) || !unit || count < 1 || count > max) throw Error();
      const length = unit * count,
        at = length <= 4 ? entry + 8 : u32(entry + 8);
      if (at < 8 || at > bytes.length - length) throw Error();
      return { type, count, at, length };
    };
    const text = (entry: number | undefined, max = 256) => {
      const d = data(entry, [2], max);
      if (!d) return undefined;
      return (
        new TextDecoder()
          .decode(bytes.subarray(d.at, d.at + d.length))
          .replace(/\0.*$/s, '')
          .replace(/[\x00-\x1f\x7f]/g, '')
          .trim() || undefined
      );
    };
    const numbers = (entry: number | undefined) => {
      const d = data(entry, [1, 3, 4, 5], 3);
      if (!d) return [];
      return Array.from({ length: d.count }, (_, i) => {
        const at = d.at + i * ({ 1: 1, 3: 2, 4: 4, 5: 8 } as Record<number, number>)[d.type]!;
        if (d.type === 5) {
          const denominator = u32(at + 4);
          if (!denominator) throw Error();
          return u32(at) / denominator;
        }
        return d.type === 1 ? bytes[at]! : d.type === 3 ? u16(at) : u32(at);
      });
    };
    const pointer = (entry: number | undefined) => {
      const d = data(entry, [4], 1);
      return d ? u32(d.at) : null;
    };
    const safe = (read: () => void) => {
      try {
        read();
      } catch {
        result.warning = '部分原件 EXIF 字段无效或不受支持，已跳过；原件保持不变';
      }
    };
    const root = table(u32(4));
    for (const [tag, key] of [
      [0x010f, 'make'],
      [0x0110, 'model'],
      [0x010e, 'description'],
    ] as const)
      safe(() => {
        const v = text(root.get(tag), key === 'description' ? 4096 : 256);
        if (v) result[key] = v;
      });
    safe(() => {
      const v = numbers(root.get(0x0112))[0];
      if (v && v >= 1 && v <= 8) result.orientation = String(v);
    });
    safe(() => {
      const at = pointer(root.get(0x8769));
      if (at === null) return;
      const exif = table(at);
      safe(() => {
        const raw = text(exif.get(0x9003));
        if (raw) {
          const sub = text(exif.get(0x9291));
          result.originalDateTime = localPhotoTime(
            raw.replace(/^(\d{4}):(\d\d):(\d\d) /, '$1-$2-$3T') +
              (sub && /^\d+$/.test(sub) ? '.' + sub.slice(0, 3) : ''),
          );
        }
      });
      safe(() => {
        const v = text(exif.get(0x9011));
        if (v) result.originalOffset = photoTimeZone(v);
      });
      safe(() => {
        const v = text(exif.get(0xa434));
        if (v) result.lensModel = v;
      });
      for (const [tag, key] of [
        [0x829d, 'fNumber'],
        [0x920a, 'focalLength'],
        [0x8827, 'iso'],
      ] as const)
        safe(() => {
          const v = numbers(exif.get(tag))[0];
          if (v !== undefined && Number.isFinite(v) && v > 0 && v < 1e8) result[key] = v;
        });
      safe(() => {
        const v = numbers(exif.get(0x829a))[0];
        if (v && v > 0 && v < 86400) {
          const d = data(exif.get(0x829a), [5], 1);
          if (d) {
            let a = u32(d.at),
              b = u32(d.at + 4);
            let x = a,
              y = b;
            while (y) [x, y] = [y, x % y];
            a /= x;
            b /= x;
            result.exposureTime = b === 1 ? String(a) : `${a}/${b}`;
          }
        }
      });
    });
    safe(() => {
      const at = pointer(root.get(0x8825));
      if (at === null) return;
      const gps = table(at),
        latitude = numbers(gps.get(2)),
        longitude = numbers(gps.get(4));
      const latRef = text(gps.get(1)),
        lonRef = text(gps.get(3));
      if (!latitude.length && !longitude.length) return;
      if (
        latitude.length !== 3 ||
        longitude.length !== 3 ||
        !['N', 'S'].includes(latRef ?? '') ||
        !['E', 'W'].includes(lonRef ?? '') ||
        latitude[1]! >= 60 ||
        latitude[2]! >= 60 ||
        longitude[1]! >= 60 ||
        longitude[2]! >= 60
      )
        throw Error();
      const lat =
          (latitude[0]! + latitude[1]! / 60 + latitude[2]! / 3600) * (latRef === 'S' ? -1 : 1),
        lon =
          (longitude[0]! + longitude[1]! / 60 + longitude[2]! / 3600) * (lonRef === 'W' ? -1 : 1);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw Error();
      result.latitude = Number(lat.toFixed(7));
      result.longitude = Number(lon.toFixed(7));
    });
  } catch {
    result.warning = '原件 EXIF 资料无法完整读取，可手动填写照片资料；原件保持不变';
  }
  return result;
}
