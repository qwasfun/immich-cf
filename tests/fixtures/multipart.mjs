import { readFile } from 'node:fs/promises';

export const boundary = 'immich-cf.multipart+boundary';
export async function multipartCases() {
  const bytes = await readFile('tests/fixtures/small.png');
  const line = (name, value) =>
    Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
      Buffer.from(value),
      Buffer.from('\r\n'),
    ]);
  const asset = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="静态图.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from('\r\n'),
  ]);
  const dates = Buffer.concat([
    line('fileCreatedAt', '2026-10-17T00:00:00Z'),
    line('fileModifiedAt', '2026-10-17T00:00:00Z'),
    line('metadata', JSON.stringify([{ key: 'mobile-app', value: { cloudId: '分块中文元数据' } }])),
  ]);
  const prefix = Buffer.concat([asset, dates]);
  const end = Buffer.from(`--${boundary}--`);
  const type = `Multipart/Form-Data; boundary="${boundary}"`;
  const header =
    'Content-Disposition: form-data; name="assetData"; filename="small.png"\r\nContent-Type: image/png\r\nX-Noise: ';
  const headerAtLimit = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n${header}${'x'.repeat(8192 - Buffer.byteLength(header))}\r\n\r\n`,
    ),
    bytes,
    Buffer.from('\r\n'),
    dates,
    end,
  ]);
  return {
    bytes,
    type,
    valid: Buffer.concat([prefix, end]),
    headerAtLimit,
    invalid: [
      {
        name: 'parser-part-limit',
        body: Buffer.concat([
          prefix,
          ...Array.from({ length: 1024 }, (_, i) => line(`extra${i}`, '')),
          end,
        ]),
        field: '上传表单',
      },
      {
        name: 'closing-truncated',
        body: Buffer.concat([prefix, end.subarray(0, -1)]),
        field: 'assetData',
      },
      {
        name: 'closing-suffix',
        body: Buffer.concat([prefix, end, Buffer.from('X')]),
        field: 'assetData',
      },
      {
        name: 'closing-crlf',
        body: Buffer.concat([prefix, end, Buffer.from('\rX')]),
        field: 'assetData',
      },
      {
        name: 'duplicate-file',
        body: Buffer.concat([asset, asset, dates, end]),
        field: 'assetData',
      },
      {
        name: 'invalid-utf8',
        body: Buffer.concat([asset, line('fileCreatedAt', Buffer.from([255])), end]),
        field: 'fileCreatedAt',
      },
      {
        name: 'part-header-limit',
        body: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="small.png"\r\nX-Noise: ${'x'.repeat(8193)}\r\n\r\n`,
          ),
          Buffer.alloc(32768),
          Buffer.from('\r\n'),
          dates,
          end,
        ]),
        field: '上传分段头',
      },
    ],
  };
}
