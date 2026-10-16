import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
function chunk(type, data = Buffer.alloc(0)) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
export async function pngCases() {
  const png = await readFile('tests/fixtures/small.png');
  const parts = [];
  for (let n = 8; n < png.length;) {
    const size = png.readUInt32BE(n) + 12;
    parts.push(png.subarray(n, n + size));
    n += size;
  }
  const header = parts[0].subarray(8, -4);
  const data = Buffer.concat(
    parts.filter((p) => p.toString('ascii', 4, 8) === 'IDAT').map((p) => p.subarray(8, -4)),
  );
  const head = chunk('IHDR', header),
    end = chunk('IEND'),
    idat = chunk('IDAT', data);
  const pack = (...items) => Buffer.concat([png.subarray(0, 8), ...items]);
  const change = (index, value) => {
    const h = Buffer.from(header);
    h[index] = value;
    return chunk('IHDR', h);
  };
  const indexed = Buffer.from(header);
  indexed.writeUInt32BE(1, 0);
  indexed.writeUInt32BE(1, 4);
  indexed[8] = 1;
  indexed[9] = 3;
  indexed[12] = 0;
  const ih = chunk('IHDR', indexed),
    palette = chunk('PLTE', Buffer.from([0, 128, 128, 255, 255, 255]));
  const indexedData = chunk('IDAT', deflateSync(Buffer.from([0, 0])));
  const split = [
    chunk('IDAT', data.subarray(0, 1)),
    chunk('IDAT'),
    chunk('IDAT', data.subarray(1)),
  ];
  const bad = (name, ...items) => ({ name, bytes: pack(...items), status: 400 });
  return [
    bad('duplicate-header', head, head, idat, end),
    bad('invalid-color', change(9, 1), idat, end),
    bad('invalid-depth', change(8, 3), idat, end),
    bad('invalid-compression', change(10, 1), idat, end),
    bad('invalid-filter', change(11, 1), idat, end),
    bad('invalid-interlace', change(12, 2), idat, end),
    bad(
      'separated-idat',
      head,
      split[0],
      chunk('tEXt', Buffer.from('Comment\0test')),
      ...split.slice(1),
      end,
    ),
    bad('empty-idat', head, chunk('IDAT'), end),
    bad('unknown-critical', head, chunk('ABCD'), idat, end),
    bad('invalid-chunk-name', head, chunk('a1CD'), idat, end),
    bad('reserved-chunk-bit', head, chunk('abca'), idat, end),
    ...['acTL', 'fcTL', 'fdAT'].map((type) =>
      bad(`animation-${type}`, head, chunk(type, Buffer.alloc(26)), idat, end),
    ),
    bad('missing-palette', ih, indexedData, end),
    bad('late-palette', ih, indexedData, palette, end),
    bad('duplicate-palette', ih, palette, palette, indexedData, end),
    bad('oversized-palette', ih, chunk('PLTE', Buffer.alloc(9)), indexedData, end),
    bad('empty-palette', ih, chunk('PLTE'), indexedData, end),
    bad('invalid-palette-length', ih, chunk('PLTE', Buffer.alloc(4)), indexedData, end),
    bad('grayscale-palette', change(9, 0), palette, idat, end),
    { name: 'ordinary-png-after-failures', bytes: png, status: 201 },
    { name: 'consecutive-idat-with-empty-chunk', bytes: pack(head, ...split, end), status: 201 },
    { name: 'indexed-png', bytes: pack(ih, palette, indexedData, end), status: 201 },
  ];
}
