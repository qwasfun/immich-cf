import { randomUUID } from 'node:crypto';
export const pairId = () => randomUUID();
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const full = Buffer.alloc(4);
export function box(name, ...data) {
  const payload = Buffer.concat(data.map((x) => Buffer.from(x)));
  return Buffer.concat([
    u32(payload.length + 8),
    typeof name === 'number' ? u32(name) : Buffer.from(name),
    payload,
  ]);
}
export function liveExif(id) {
  const note = Buffer.alloc(16 + 12 + 4 + id.length + 1);
  note.write('Apple iOS\0');
  note[11] = 1;
  note.write('MM', 12);
  note.writeUInt16BE(1, 14);
  note.writeUInt16BE(0x11, 16);
  note.writeUInt16BE(2, 18);
  note.writeUInt32BE(id.length + 1, 20);
  note.writeUInt32BE(32, 24);
  note.write(id, 32);
  const tiff = Buffer.alloc(44 + note.length);
  tiff.write('MM');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8769, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(26, 18);
  tiff.writeUInt16BE(1, 26);
  tiff.writeUInt16BE(0x927c, 28);
  tiff.writeUInt16BE(7, 30);
  tiff.writeUInt32BE(note.length, 32);
  tiff.writeUInt32BE(44, 36);
  note.copy(tiff, 44);
  return tiff;
}
export function liveJpeg(id, padding = 0) {
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), liveExif(id)]);
  return Buffer.concat([
    Buffer.from([255, 216, 255, 225]),
    u16(exif.length + 2),
    exif,
    Buffer.from([255, 192, 0, 11, 8, 0, 2, 0, 3, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0]),
    Buffer.alloc(padding, 0x20),
    Buffer.from([0x20, 255, 217]),
  ]);
}
export function liveMov(id, padding = 16) {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(3000, 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(3 * 65536, 76);
  tkhd.writeUInt32BE(2 * 65536, 80);
  const key = Buffer.from('com.apple.quicktime.content.identifier'),
    keys = box('keys', full, u32(1), u32(key.length + 8), Buffer.from('mdta'), key),
    ilst = box('ilst', box(1, box('data', u32(1), u32(0), Buffer.from(id))));
  return Buffer.concat([
    box('ftyp', Buffer.from('qt  '), u32(0), Buffer.from('qt  ')),
    box(
      'moov',
      box('mvhd', mvhd),
      box(
        'trak',
        box('tkhd', tkhd),
        box(
          'mdia',
          box('minf', box('stbl', box('stsd', full, u32(1), box('hvc1', Buffer.alloc(78))))),
        ),
      ),
      box('udta', box('meta', full, keys, ilst)),
      box('free', Buffer.from('com.apple.quicktime.still-image-time')),
    ),
    box('mdat', Buffer.alloc(padding, 0x20)),
  ]);
}
export function liveHeic(id) {
  const exif = Buffer.concat([u32(0), liveExif(id)]);
  const meta = box(
    'meta',
    full,
    box('pitm', full, u16(1)),
    box(
      'iinf',
      full,
      u16(1),
      box(
        'infe',
        Buffer.from([2, 0, 0, 0]),
        u16(2),
        u16(0),
        Buffer.from('Exif'),
        Buffer.from('Exif\0'),
      ),
    ),
    box(
      'iloc',
      Buffer.from([1, 0, 0, 0, 0x44, 0]),
      u16(1),
      u16(2),
      u16(1),
      u16(0),
      u16(1),
      u32(0),
      u32(exif.length),
    ),
    box(
      'iprp',
      box('ipco', box('ispe', full, u32(3), u32(2))),
      box('ipma', full, u32(1), u16(1), Buffer.from([1, 1])),
    ),
    box('idat', exif),
  );
  return Buffer.concat([
    box('ftyp', Buffer.from('heic'), u32(0), Buffer.from('heicmif1')),
    meta,
    box('mdat', Buffer.from([1])),
  ]);
}
