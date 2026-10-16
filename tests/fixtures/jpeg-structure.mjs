import { readFile } from 'node:fs/promises';
import { withXmp, appleExif } from './live-photo-exif.mjs';
import { withExif } from './exif.mjs';
import { staticXmp } from './static-xmp.mjs';

export async function jpegCases() {
  const jpg = await readFile('tests/fixtures/small.jpg');
  const progressive = await readFile('tests/fixtures/progressive.jpg');
  const restart = await readFile('tests/fixtures/restart.jpg');
  const appendBeforeEnd = (segment) =>
    Buffer.concat([jpg.subarray(0, -2), segment, jpg.subarray(-2)]);
  const extract = (wrapped) => wrapped.subarray(2, wrapped.length - jpg.length + 2);
  const sos = jpg.indexOf(Buffer.from([255, 218]));
  const badLength = Buffer.from(jpg);
  badLength.writeUInt16BE(65535, sos + 2);
  return [
    { name: 'baseline', bytes: jpg, status: 201 },
    { name: 'progressive', bytes: progressive, status: 201 },
    { name: 'restart-and-stuffing', bytes: restart, status: 201 },
    {
      name: 'late-static-xmp',
      bytes: appendBeforeEnd(extract(withXmp(jpg, 'jpg', 'iTXt', staticXmp))),
      status: 201,
    },
    {
      name: 'late-live-photo',
      bytes: appendBeforeEnd(extract(withExif(jpg, appleExif()))),
      status: 400,
    },
    { name: 'late-unknown-xmp', bytes: appendBeforeEnd(extract(withXmp(jpg))), status: 400 },
    {
      name: 'truncated-segment',
      bytes: appendBeforeEnd(Buffer.from([255, 225, 255, 255])),
      status: 400,
    },
    { name: 'trailing-image', bytes: Buffer.concat([jpg, jpg]), status: 400 },
    { name: 'second-soi', bytes: appendBeforeEnd(Buffer.from([255, 216])), status: 400 },
    { name: 'bad-sos-length', bytes: badLength, status: 400 },
    { name: 'missing-eoi', bytes: jpg.subarray(0, -2), status: 400 },
  ];
}
