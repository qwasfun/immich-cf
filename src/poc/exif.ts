import { invalid } from './http';

// Only TIFF IFD0 Orientation. Never follow thumbnail, GPS, Exif or next-IFD pointers.
export function exifOrientation(bytes: Uint8Array): number | undefined {
  const fail = (): never => invalid('assetData', 'EXIF 方向信息无效或不完整，请重新导出图片后上传');
  if (bytes.length < 8) return fail();
  const endian = String.fromCharCode(bytes[0]!, bytes[1]!);
  if (endian !== 'II' && endian !== 'MM') return fail();
  const little = endian === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return fail();
  const offset = view.getUint32(4, little);
  if (offset < 8 || offset > bytes.length - 2) return fail();
  const count = view.getUint16(offset, little);
  if (offset + 2 + count * 12 + 4 > bytes.length) return fail();
  let orientation: number | undefined;
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    if (
      orientation !== undefined ||
      view.getUint16(entry + 2, little) !== 3 ||
      view.getUint32(entry + 4, little) !== 1
    )
      return fail();
    orientation = view.getUint16(entry + 8, little);
    if (orientation < 1 || orientation > 8) return fail();
  }
  return orientation;
}
