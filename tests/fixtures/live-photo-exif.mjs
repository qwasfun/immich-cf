import { crc32 } from 'node:zlib';
// Synthetic Apple v1 MakerNote wrapped in TIFF IFD0/ExifIFD; no real personal identifiers.
export function appleExif(tag = 0x11, little = true, makerLittle = false) {
  const out = Buffer.alloc(76);
  const u16 = (v, o) => (little ? out.writeUInt16LE(v, o) : out.writeUInt16BE(v, o));
  const u32 = (v, o) => (little ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o));
  out.write(little ? 'II' : 'MM');
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x8769, 10);
  u16(4, 12);
  u32(1, 14);
  u32(26, 18);
  u16(1, 26);
  u16(0x927c, 28);
  u16(7, 30);
  u32(32, 32);
  u32(44, 36);
  out.write('Apple iOS\0', 44);
  out[55] = 1;
  out.write(makerLittle ? 'II' : 'MM', 56);
  const m16 = (v, o) => (makerLittle ? out.writeUInt16LE(v, o) : out.writeUInt16BE(v, o));
  const m32 = (v, o) => (makerLittle ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o));
  m16(1, 58);
  m16(tag, 60);
  m16(4, 62);
  m32(1, 64);
  m32(1, 68);
  return out;
}
export function withXmp(image, format = 'jpg', type = 'iTXt', xml = '<test/>') {
  if (format === 'jpg') {
    const payload = Buffer.from('http://ns.adobe.com/xap/1.0/\0' + xml);
    const header = Buffer.from([255, 225, 0, 0]);
    header.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([image.subarray(0, 2), header, payload, image.subarray(2)]);
  }
  const payload = Buffer.from('XML:com.adobe.xmp\0' + (type === 'iTXt' ? '\0\0\0\0' : '') + xml);
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length);
  chunk.write(type, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([image.subarray(0, 33), chunk, image.subarray(33)]);
}
