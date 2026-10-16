import { invalid } from './http';
import { exifOrientation } from './exif';
import { rejectLivePhotoExif } from './live-photo-exif';
import { checkPngXmp, checkStaticXmp, xmpFailure } from './xmp';

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Bounded container/header and IFD0 orientation inspection, not a full image decoder.
export function imageHeader(bytes: Uint8Array) {
  let orientation: number | undefined;
  let sawExif = false;
  let sawXmp = false;
  const readExif = (data: Uint8Array) => {
    if (sawExif) invalid('assetData', 'EXIF 块重复，请重新导出只有一份方向信息的图片');
    sawExif = true;
    orientation = exifOrientation(data);
    rejectLivePhotoExif(data);
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0,
    mime = '';
  if (bytes.length >= 45 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) {
    let offset = 8,
      sawData = false,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12)
        invalid('assetData', 'PNG 文件不完整，请重新导出图片');
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (
        crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
        view.getUint32(offset + 8 + length)
      )
        invalid('assetData', 'PNG 校验和错误，文件可能已损坏，请重新导出原图后上传');
      if (offset === 8) {
        if (type !== 'IHDR' || length !== 13) invalid('assetData', 'PNG 头无效，请重新导出图片');
        width = view.getUint32(offset + 8);
        height = view.getUint32(offset + 12);
      }
      if (type === 'acTL') invalid('assetData', '暂不支持动画 PNG，请选择静态图片');
      if (
        ['iTXt', 'tEXt', 'zTXt'].includes(type) &&
        checkPngXmp(bytes.subarray(offset + 8, offset + 8 + length), type)
      ) {
        if (sawXmp) xmpFailure();
        sawXmp = true;
      }
      if (type === 'eXIf') readExif(bytes.subarray(offset + 8, offset + 8 + length));
      if (type === 'IDAT') sawData = true;
      offset += length + 12;
      if (type === 'IEND') {
        ended = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!sawData || !ended) invalid('assetData', 'PNG 文件不完整，请重新导出图片');
    mime = 'image/png';
  } else if (
    bytes.length >= 12 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  ) {
    let offset = 2,
      scan = false,
      inScan = false,
      ended = false;
    const fail = (): never =>
      invalid('assetData', 'JPEG 扫描段或文件结构不完整，请重新导出完整原图后上传');
    while (offset < bytes.length) {
      if (inScan) {
        while (offset < bytes.length && bytes[offset] !== 255) offset++;
      }
      if (offset >= bytes.length || bytes[offset++] !== 255) fail();
      while (bytes[offset] === 255) offset++;
      if (offset >= bytes.length) fail();
      const marker = bytes[offset++]!;
      if (inScan && (marker === 0 || (marker >= 208 && marker <= 215))) continue;
      inScan = false;
      if (marker === 217) {
        if (!scan || offset !== bytes.length) fail();
        ended = true;
        break;
      }
      if (marker === 0 || marker === 216 || marker === 1 || (marker >= 208 && marker <= 215))
        fail();
      if (offset + 2 > bytes.length) fail();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) fail();
      if (marker === 225) {
        if (length >= 8 && [69, 120, 105, 102, 0, 0].every((n, i) => bytes[offset + 2 + i] === n))
          readExif(bytes.subarray(offset + 8, offset + length));
        else {
          const data = bytes.subarray(offset + 2, offset + length);
          const signature = 'http://ns.adobe.com/xap/1.0/\0';
          if (sawXmp || !Array.from(signature).every((c, i) => data[i] === c.charCodeAt(0)))
            xmpFailure();
          sawXmp = true;
          checkStaticXmp(data.subarray(signature.length));
        }
      }
      if (marker === 192 || marker === 194) {
        if (
          width ||
          length < 11 ||
          length !== 8 + 3 * bytes[offset + 7]! ||
          bytes[offset + 2] !== 8
        )
          fail();
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
      }
      if (marker === 218) {
        if (!width || !height || length < 8 || length !== 6 + 2 * bytes[offset + 2]!) fail();
        scan = true;
        inScan = true;
      }
      offset += length;
    }
    if (ended) mime = 'image/jpeg';
  }
  if (!mime || !width || !height)
    invalid('assetData', '请选择有效的静态 JPEG 或 PNG 图片，不支持 HEIC、视频或 Live Photo');
  if (width > 4096 || height > 4096 || width * height > 4_000_000)
    invalid('assetData', '图片最多 400 万像素，且宽高均不超过 4096，请缩小后上传');
  // Match frozen Immich asset dimensions; original EXIF/pixels remain unchanged.
  if (orientation !== undefined && orientation >= 5) [width, height] = [height, width];
  return { width, height, mime };
}
