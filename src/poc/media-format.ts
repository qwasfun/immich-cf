import { HttpError, invalid } from './http';
import { exifOrientation } from './exif';
import { rejectLivePhotoExif } from './live-photo-exif';
import { checkPngXmp, checkStaticXmp, xmpFailure } from './xmp';

export const MAX_PHOTO = 20_000_000;
export const MAX_MOTION = 64 * 1024 * 1024;
export interface MediaInfo {
  mime: string;
  width: number;
  height: number;
  type: 'IMAGE' | 'VIDEO';
  duration: string | null;
  pair: string | null;
  marked: boolean;
}
function bad(): never {
  return invalid('assetData', '媒体容器、尺寸或配对元数据不完整，请重新选择未修改的照片及动态原件');
}
const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const u16 = (b: Uint8Array, n: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(n);
const u32 = (b: Uint8Array, n: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(n);
const u64 = (b: Uint8Array, n: number) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(n);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) bad();
  return Number(v);
};
function identifier(value: string) {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(value)) bad();
  return value;
}
interface Box {
  name: string;
  index: number;
  start: number;
  end: number;
  data: Uint8Array;
}
function boxes(bytes: Uint8Array, start = 0): Box[] {
  const result: Box[] = [];
  while (start < bytes.length) {
    if (result.length >= 4096 || start + 8 > bytes.length) bad();
    let length = u32(bytes, start),
      header = 8;
    if (length === 1) {
      if (start + 16 > bytes.length) bad();
      length = u64(bytes, start + 8);
      header = 16;
    }
    if (length === 0) length = bytes.length - start;
    if (length < header || length > bytes.length - start) bad();
    result.push({
      name: text(bytes.subarray(start + 4, start + 8)),
      index: u32(bytes, start + 4),
      start,
      end: start + length,
      data: bytes.subarray(start + header, start + length),
    });
    start += length;
  }
  return result;
}
// At most one 64 KiB network chunk and bounded metadata are retained, never the image pixels.
class StreamBytes {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private ended = false;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  async available(): Promise<boolean> {
    if (this.offset < this.chunk.length) return true;
    if (this.ended) return false;
    const item = await this.reader.read();
    if (item.done) {
      this.ended = true;
      return false;
    }
    this.chunk = item.value;
    this.offset = 0;
    return this.chunk.length ? true : this.available();
  }
  async take(n: number) {
    if (n > 262144) bad();
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      if (!(await this.available())) bad();
      const count = Math.min(n - at, this.chunk.length - this.offset);
      out.set(this.chunk.subarray(this.offset, this.offset + count), at);
      this.offset += count;
      at += count;
    }
    return out;
  }
  async consume(n: number, visit: (bytes: Uint8Array) => void) {
    while (n) {
      if (!(await this.available())) bad();
      const count = Math.min(n, this.chunk.length - this.offset);
      visit(this.chunk.subarray(this.offset, this.offset + count));
      this.offset += count;
      n -= count;
    }
  }
  async marker(inScan: boolean): Promise<number> {
    while (true) {
      if (inScan) {
        while (await this.available()) {
          const found = this.chunk.indexOf(255, this.offset);
          if (found < 0) {
            this.offset = this.chunk.length;
            continue;
          }
          this.offset = found + 1;
          break;
        }
      } else if ((await this.take(1))[0] !== 255) bad();
      let marker: number;
      do {
        marker = (await this.take(1))[0]!;
      } while (marker === 255);
      if (inScan && (marker === 0 || (marker >= 208 && marker <= 215))) continue;
      return marker;
    }
  }
  async end() {
    if (await this.available()) bad();
  }
  async close() {
    await this.reader.cancel().catch(() => undefined);
    this.reader.releaseLock();
  }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(crc: number, b: Uint8Array) {
  for (const v of b) crc = crcTable[(crc ^ v) & 255]! ^ (crc >>> 8);
  return crc >>> 0;
}
export async function inspectMedia(
  bucket: R2Bucket,
  key: string,
  size: number,
): Promise<MediaInfo> {
  const first = await bucket.get(key, { range: { offset: 0, length: 16 } });
  if (!first) bad();
  const prefix = new Uint8Array(await first.arrayBuffer());
  let pair: string | null = null,
    marked = false,
    orientation: number | undefined;
  const readExif = (bytes: Uint8Array) => {
    orientation = exifOrientation(bytes);
    rejectLivePhotoExif(bytes, (id) => {
      marked = true;
      if (id) {
        if (pair && pair !== id) bad();
        pair = id;
      }
    });
  };
  if (
    (prefix[0] === 255 && prefix[1] === 216) ||
    (prefix[0] === 137 && text(prefix.subarray(1, 4)) === 'PNG')
  ) {
    if (size > MAX_PHOTO)
      throw new HttpError(
        413,
        'assetData：照片最多 20,000,000 字节，请选择符合上限的原件',
        'assetData',
      );
    const object = await bucket.get(key);
    if (!object) bad();
    const r = new StreamBytes(object.body);
    let width = 0,
      height = 0,
      mime = '',
      sawExif = false,
      sawXmp = false;
    const exif = (b: Uint8Array) => {
      if (sawExif) bad();
      sawExif = true;
      readExif(b);
    };
    try {
      if (prefix[0] === 255) {
        await r.take(2);
        let inScan = false,
          scan = false;
        while (true) {
          const marker = await r.marker(inScan);
          inScan = false;
          if (marker === 217) {
            if (!scan) bad();
            await r.end();
            break;
          }
          if ([0, 1, 216].includes(marker) || (marker >= 208 && marker <= 215)) bad();
          const length = u16(await r.take(2), 0);
          if (length < 2) bad();
          const data = await r.take(length - 2);
          if (marker === 225) {
            if (text(data.subarray(0, 6)) === 'Exif\0\0') exif(data.subarray(6));
            else {
              const signature = 'http://ns.adobe.com/xap/1.0/\0';
              if (sawXmp || text(data.subarray(0, signature.length)) !== signature) xmpFailure();
              sawXmp = true;
              checkStaticXmp(data.subarray(signature.length));
            }
          }
          if (marker === 192 || marker === 194) {
            if (width || data.length < 9 || data.length !== 6 + 3 * data[5]! || data[0] !== 8)
              bad();
            height = u16(data, 1);
            width = u16(data, 3);
          }
          if (marker === 218) {
            if (!width || !height || data.length < 6 || data.length !== 4 + 2 * data[0]!) bad();
            inScan = true;
            scan = true;
          }
        }
        mime = 'image/jpeg';
      } else {
        if (!(await r.take(8)).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i])) bad();
        let chunks = 0,
          dataSeen = false,
          dataEnded = false,
          palette = false,
          color = 0,
          depth = 0,
          dataBytes = 0;
        while (true) {
          const header = await r.take(8),
            length = u32(header, 0),
            name = text(header.subarray(4));
          if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(name) || length > size || ++chunks > 100000) bad();
          if (/^[A-Z]/.test(name) && !['IHDR', 'IDAT', 'IEND', 'PLTE'].includes(name)) bad();
          let sum = crc(0xffffffff, header.subarray(4));
          let data: Uint8Array | undefined;
          if (['IHDR', 'PLTE', 'eXIf', 'iTXt', 'tEXt', 'zTXt'].includes(name)) {
            data = await r.take(length);
            sum = crc(sum, data);
          } else
            await r.consume(length, (b) => {
              sum = crc(sum, b);
            });
          if ((sum ^ 0xffffffff) >>> 0 !== u32(await r.take(4), 0)) bad();
          if (chunks === 1) {
            if (name !== 'IHDR' || length !== 13) bad();
            width = u32(data!, 0);
            height = u32(data!, 4);
            depth = data![8]!;
            color = data![9]!;
            const depths: Record<number, number[]> = {
              0: [1, 2, 4, 8, 16],
              2: [8, 16],
              3: [1, 2, 4, 8],
              4: [8, 16],
              6: [8, 16],
            };
            if (
              !depths[color]?.includes(depth) ||
              data![10] !== 0 ||
              data![11] !== 0 ||
              data![12]! > 1
            )
              bad();
          } else if (name === 'IHDR') bad();
          if (name === 'PLTE') {
            if (
              palette ||
              dataSeen ||
              color === 0 ||
              color === 4 ||
              !length ||
              length % 3 ||
              length > 768 ||
              (color === 3 && length / 3 > 2 ** depth)
            )
              bad();
            palette = true;
          }
          if (['acTL', 'fcTL', 'fdAT'].includes(name))
            invalid('assetData', '暂不支持动画 PNG，请选择静态图片');
          if (name === 'eXIf') exif(data!);
          if (['iTXt', 'tEXt', 'zTXt'].includes(name) && checkPngXmp(data!, name)) {
            if (sawXmp) xmpFailure();
            sawXmp = true;
          }
          if (name === 'IDAT') {
            if (dataEnded || (color === 3 && !palette)) bad();
            dataSeen = true;
            dataBytes += length;
          } else if (dataSeen) dataEnded = true;
          if (name === 'IEND') {
            if (length || !dataBytes) bad();
            await r.end();
            break;
          }
        }
        mime = 'image/png';
      }
      if (orientation !== undefined && orientation >= 5) [width, height] = [height, width];
      return dimensions({ mime, width, height, pair, marked, type: 'IMAGE', duration: null });
    } finally {
      await r.close();
    }
  }
  const top: Box[] = [];
  let metadataBytes = 0;
  let at = 0,
    mdat = false;
  while (at < size) {
    if (top.length >= 128 || at + 8 > size) bad();
    const h = await range(bucket, key, at, Math.min(16, size - at));
    let length = u32(h, 0),
      head = 8;
    if (length === 1) {
      length = u64(h, 8);
      head = 16;
    }
    if (!length) length = size - at;
    if (length < head || length > size - at) bad();
    const name = text(h.subarray(4, 8));
    if (name === 'mdat') {
      if (length <= head) bad();
      mdat = true;
    }
    if (['ftyp', 'meta', 'moov'].includes(name)) {
      metadataBytes += length - head;
      if (metadataBytes > 4 * 1024 * 1024 || (name === 'ftyp' && length - head > 4096)) bad();
    }
    const data = ['ftyp', 'meta', 'moov'].includes(name)
      ? await range(bucket, key, at + head, length - head)
      : new Uint8Array();
    top.push({ name, index: 0, start: at, end: at + length, data });
    at += length;
  }
  const ftyp = top.find((x) => x.name === 'ftyp')?.data;
  if (!ftyp || ftyp.length < 8) bad();
  const brands = text(ftyp);
  if (/heic|heix|hevc|hevx/.test(brands)) {
    if (size > MAX_PHOTO)
      throw new HttpError(
        413,
        'assetData：照片最多 20,000,000 字节，请选择符合上限的原件',
        'assetData',
      );
    const meta = top.find((x) => x.name === 'meta');
    if (!meta || top.filter((x) => x.name === 'meta').length !== 1) bad();
    const children = boxes(meta.data, 4),
      pitm = children.find((x) => x.name === 'pitm')?.data;
    if (!pitm) bad();
    const primary = pitm[0] === 0 ? u16(pitm, 4) : u32(pitm, 4);
    const iprp = children.find((x) => x.name === 'iprp');
    if (!iprp) bad();
    const props = boxes(iprp.data),
      ipco = props.find((x) => x.name === 'ipco'),
      ipma = props.find((x) => x.name === 'ipma')?.data;
    if (!ipco || !ipma) bad();
    const properties = boxes(ipco.data);
    let o = 8;
    const associated: number[] = [];
    const entries = u32(ipma, 4);
    if (entries > 4096) bad();
    for (let i = 0; i < entries; i++) {
      const id = ipma[0] === 0 ? u16(ipma, o) : u32(ipma, o);
      o += ipma[0] === 0 ? 2 : 4;
      const count = ipma[o++]!;
      for (let j = 0; j < count; j++) {
        const large = (ipma[3]! & 1) !== 0;
        const index = large ? u16(ipma, o) & 0x7fff : ipma[o]! & 0x7f;
        o += large ? 2 : 1;
        if (id === primary) associated.push(index);
      }
    }
    if (o !== ipma.length) bad();
    let width = 0,
      height = 0,
      rot = 0;
    for (const n of associated) {
      if (!n) continue;
      const p = properties[n - 1];
      if (!p) bad();
      if (p.name === 'ispe') {
        if (width || p.data.length !== 12) bad();
        width = u32(p.data, 4);
        height = u32(p.data, 8);
      }
      if (p.name === 'irot') {
        if (p.data.length !== 1) bad();
        rot = p.data[0]! & 3;
      }
    }
    const iinf = children.find((x) => x.name === 'iinf')?.data,
      iloc = children.find((x) => x.name === 'iloc')?.data;
    if (!iinf || !iloc) bad();
    const infos = boxes(iinf, iinf[0] === 0 ? 6 : 8);
    const exifs = infos.filter(
      (x) =>
        x.name === 'infe' &&
        (x.data[0] === 2
          ? text(x.data.subarray(8, 12))
          : x.data[0] === 3
            ? text(x.data.subarray(10, 14))
            : '') === 'Exif',
    );
    if (exifs.length > 1) bad();
    if (exifs.length) {
      const d = exifs[0]!.data,
        id = d[0] === 2 ? u16(d, 4) : u32(d, 4);
      let pos = 6;
      const version = iloc[0]!,
        offsetSize = iloc[4]! >>> 4,
        lengthSize = iloc[4]! & 15,
        baseSize = iloc[5]! >>> 4,
        indexSize = version ? iloc[5]! & 15 : 0;
      const num = version < 2 ? u16(iloc, pos) : u32(iloc, pos);
      pos += version < 2 ? 2 : 4;
      if (version > 2 || num > 4096) bad();
      const integer = (n: number) => {
        if (![0, 4, 8].includes(n) || pos + n > iloc.length) bad();
        const value = n === 0 ? 0 : n === 4 ? u32(iloc, pos) : u64(iloc, pos);
        pos += n;
        return value;
      };
      let found = false;
      for (let i = 0; i < num; i++) {
        const item = version < 2 ? u16(iloc, pos) : u32(iloc, pos);
        pos += version < 2 ? 2 : 4;
        const method = version ? u16(iloc, pos) & 15 : 0;
        if (version) pos += 2;
        const reference = u16(iloc, pos);
        pos += 2;
        const base = integer(baseSize),
          count = u16(iloc, pos);
        pos += 2;
        if (count > 64) bad();
        for (let j = 0; j < count; j++) {
          if (indexSize) integer(indexSize);
          const offset = integer(offsetSize),
            length = integer(lengthSize);
          if (item === id) {
            if (found || count !== 1 || reference || method > 1 || length > 262144 || length < 12)
              bad();
            found = true;
            let data: Uint8Array;
            if (method === 1) {
              const source = children.find((x) => x.name === 'idat')?.data;
              if (!source || base + offset + length > source.length) bad();
              data = source.subarray(base + offset, base + offset + length);
            } else data = await range(bucket, key, base + offset, length);
            const skip = u32(data, 0);
            if (skip > data.length - 12) bad();
            readExif(data.subarray(4 + skip));
          }
        }
      }
      if (!found || pos !== iloc.length) bad();
    }
    if (rot % 2) [width, height] = [height, width];
    else if (orientation !== undefined && orientation >= 5) [width, height] = [height, width];
    return dimensions({
      mime: 'image/heic',
      width,
      height,
      type: 'IMAGE',
      duration: null,
      pair,
      marked,
    });
  }
  if (!brands.includes('qt  ') || !mdat) bad();
  const moov = top.find((x) => x.name === 'moov')?.data;
  if (!moov || top.filter((x) => x.name === 'moov').length !== 1) bad();
  let width = 0,
    height = 0,
    duration = 0,
    codec = false;
  const strings = text(moov); // Non-text codec bytes are inspected structurally below.
  const walk = (b: Uint8Array, depth: number) => {
    if (depth > 12) bad();
    for (const box of boxes(b)) {
      const d = box.data;
      if (box.name === 'mvhd') {
        const v = d[0];
        if (v !== 0 && v !== 1) bad();
        const scale = u32(d, v === 1 ? 20 : 12),
          ticks = v === 1 ? u64(d, 24) : u32(d, 16);
        if (!scale) bad();
        duration = ticks / scale;
      }
      if (box.name === 'tkhd') {
        if (d.length < 84) bad();
        const w = u32(d, d.length - 8) / 65536,
          h = u32(d, d.length - 4) / 65536;
        if (w && h) {
          width = Math.round(w);
          height = Math.round(h);
        }
      }
      if (box.name === 'stsd') {
        if (d.length < 8) bad();
        for (const sample of boxes(d, 8))
          if (['hvc1', 'hev1', 'avc1'].includes(sample.name)) codec = true;
      }
      if (box.name === 'meta') {
        const meta = boxes(d, 4),
          keys = meta.find((x) => x.name === 'keys')?.data,
          ilst = meta.find((x) => x.name === 'ilst');
        if (keys && ilst) {
          const n = u32(keys, 4);
          if (n > 4096) bad();
          let p = 8,
            index = 0;
          for (let i = 1; i <= n; i++) {
            const len = u32(keys, p);
            if (len < 8 || p + len > keys.length) bad();
            if (text(keys.subarray(p + 8, p + len)) === 'com.apple.quicktime.content.identifier')
              index = i;
            p += len;
          }
          if (p !== keys.length) bad();
          const values = boxes(ilst.data).filter((x) => x.index === index);
          if (index && values.length) {
            if (values.length !== 1 || pair) bad();
            const value = boxes(values[0]!.data).find((x) => x.name === 'data')?.data;
            if (!value || value.length < 9 || u32(value, 0) !== 1) bad();
            pair = identifier(text(value.subarray(8)));
            marked = true;
          }
        }
      } else if (['trak', 'mdia', 'minf', 'stbl', 'udta'].includes(box.name)) walk(d, depth + 1);
    }
  };
  walk(moov, 0);
  if (
    !pair ||
    !codec ||
    !strings.includes('com.apple.quicktime.still-image-time') ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 60
  )
    bad();
  const ms = Math.round(duration * 1000),
    h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60;
  return dimensions({
    mime: 'video/quicktime',
    width,
    height,
    type: 'VIDEO',
    pair,
    marked,
    duration: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`,
  });
}
function dimensions(info: MediaInfo) {
  if (
    !info.width ||
    !info.height ||
    info.width > 16384 ||
    info.height > 16384 ||
    info.width * info.height > 64_000_000
  )
    invalid('assetData', '媒体最多 6400 万像素，宽高均须在 1–16384 内，请选择符合上限的原件');
  return info;
}
async function range(bucket: R2Bucket, key: string, offset: number, length: number) {
  if (length < 0 || length > 4 * 1024 * 1024 || !Number.isSafeInteger(offset)) bad();
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) bad();
  const data = new Uint8Array(await object.arrayBuffer());
  if (data.length !== length) bad();
  return data;
}
