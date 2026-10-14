import { crc32 } from 'node:zlib';
export function tiff(orientation, little = true) {
  const out = Buffer.alloc(26);
  out.write(little ? 'II' : 'MM');
  const u16 = (value, offset) =>
    little ? out.writeUInt16LE(value, offset) : out.writeUInt16BE(value, offset);
  const u32 = (value, offset) =>
    little ? out.writeUInt32LE(value, offset) : out.writeUInt32BE(value, offset);
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x112, 10);
  u16(3, 12);
  u32(1, 14);
  u16(orientation, 18);
  return out;
}
export function withExif(image, payload, format = 'jpg') {
  if (format === 'png') {
    const chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length);
    chunk.write('eXIf', 4);
    payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return Buffer.concat([image.subarray(0, 33), chunk, image.subarray(33)]);
  }
  const segment = Buffer.alloc(payload.length + 10);
  segment[0] = 255;
  segment[1] = 225;
  segment.writeUInt16BE(payload.length + 8, 2);
  segment.write('Exif\0\0', 4);
  payload.copy(segment, 10);
  return Buffer.concat([image.subarray(0, 2), segment, image.subarray(2)]);
}
