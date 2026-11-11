import { liveExif, liveJpeg } from './live-photo-media.mjs';
import { crc32 } from 'node:zlib';

export function photoTiff({
  little = false,
  offset = '+08:00',
  local = '2020:01:01 00:30:00',
  pair,
} = {}) {
  const root = [
    [0x010f, 2, 'Example Camera'],
    [0x0110, 2, 'Test Model'],
    [0x010e, 2, '原件说明'],
    [0x0112, 3, 1],
    [0x8769, 4, 0],
    [0x8825, 4, 0],
  ];
  const exif = [
    [0x9003, 2, local],
    [0x9291, 2, '125'],
    [0xa434, 2, 'Test 35mm'],
    [0x829d, 5, [[28, 10]]],
    [0x829a, 5, [[1, 125]]],
    [0x8827, 3, 200],
    [0x920a, 5, [[35, 1]]],
  ];
  if (offset !== null) exif.push([0x9011, 2, offset]);
  if (pair) exif.push([0x927c, 7, liveExif(pair).subarray(44)]);
  const gps = [
    [1, 2, 'N'],
    [
      2,
      5,
      [
        [31, 1],
        [12, 1],
        [30, 1],
      ],
    ],
    [3, 2, 'E'],
    [
      4,
      5,
      [
        [121, 1],
        [30, 1],
        [0, 1],
      ],
    ],
  ];
  const groups = [root, exif, gps],
    starts = [];
  let end = 8;
  for (const group of groups) {
    starts.push(end);
    end += 2 + group.length * 12 + 4;
  }
  root.find((x) => x[0] === 0x8769)[2] = starts[1];
  root.find((x) => x[0] === 0x8825)[2] = starts[2];
  const result = Buffer.alloc(8192),
    write16 = (v, n) => (little ? result.writeUInt16LE(v, n) : result.writeUInt16BE(v, n)),
    write32 = (v, n) => (little ? result.writeUInt32LE(v, n) : result.writeUInt32BE(v, n));
  result.write(little ? 'II' : 'MM');
  write16(42, 2);
  write32(8, 4);
  for (let g = 0; g < groups.length; g++) {
    write16(groups[g].length, starts[g]);
    groups[g].forEach(([tag, type, value], i) => {
      const entry = starts[g] + 2 + i * 12;
      write16(tag, entry);
      write16(type, entry + 2);
      if (type === 3 || type === 4) {
        write32(1, entry + 4);
        if (type === 3) write16(value, entry + 8);
        else write32(value, entry + 8);
        return;
      }
      const bytes =
        type === 2
          ? Buffer.from(value + '\0')
          : type === 7
            ? value
            : Buffer.alloc(value.length * 8);
      write32(type === 5 ? value.length : bytes.length, entry + 4);
      const at = bytes.length <= 4 ? entry + 8 : end;
      if (bytes.length > 4) {
        write32(end, entry + 8);
        end += bytes.length;
      }
      bytes.copy(result, at);
      if (type === 5)
        value.forEach(([a, b], n) => {
          write32(a, at + n * 8);
          write32(b, at + n * 8 + 4);
        });
    });
  }
  return result.subarray(0, end);
}
export function photoJpeg(options = {}) {
  const source = liveJpeg('photo-metadata-fixture'),
    existing = source.readUInt16BE(4) + 4;
  return jpegWithExif(
    Buffer.concat([source.subarray(0, 2), source.subarray(existing)]),
    photoTiff(options),
  );
}
export function jpegWithExif(source, tiff = photoTiff()) {
  const app = Buffer.concat([Buffer.from('Exif\0\0'), tiff]),
    size = Buffer.alloc(2);
  size.writeUInt16BE(app.length + 2);
  return Buffer.concat([
    source.subarray(0, 2),
    Buffer.from([255, 225]),
    size,
    app,
    source.subarray(2),
  ]);
}
export function pngWithExif(source, tiff = photoTiff()) {
  const chunk = Buffer.alloc(tiff.length + 12);
  chunk.writeUInt32BE(tiff.length);
  chunk.write('eXIf', 4);
  tiff.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([source.subarray(0, 33), chunk, source.subarray(33)]);
}
