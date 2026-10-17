import { createDeflate, crc32 } from 'node:zlib';
import { Readable } from 'node:stream';

let png;
// An actually encoded synthetic 48MP RGB image. Stream rows in the local
// fixture generator; the Worker never decodes pixels or imports this module.
export async function largePng() {
  if (png) return png;
  const width = 8064,
    height = 6048;
  const row = Buffer.alloc(1 + width * 3, 96);
  row[0] = 0; // PNG filter None.
  const chunks = [];
  const rows = function* () {
    for (let y = 0; y < height; y++) yield row;
  };
  for await (const chunk of Readable.from(rows()).pipe(createDeflate({ level: 1 })))
    chunks.push(chunk);
  const chunk = (name, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(name, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', Buffer.concat(chunks)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}
