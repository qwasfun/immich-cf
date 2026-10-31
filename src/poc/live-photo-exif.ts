import { invalid } from './http';

// Bounded EXIF IFD0 -> ExifIFD -> Apple MakerNote inspection, not a full decoder.
// Apple layout/tag evidence: ExifTool MakerNotes.pm and Apple.pm (see P2 document).
export function rejectLivePhotoExif(bytes: Uint8Array, identified?: (id: string | null) => void) {
  const uncertain = (): never =>
    invalid(
      'assetData',
      '相机私有 EXIF 元数据无法安全识别，不能确认是否为 Live Photo；请保留原件并从当前备份相册移除此项',
    );
  const live = (): never =>
    invalid(
      'assetData',
      '检测到 Live Photo 配对元数据，当前不能完整备份；请保留照片和动态原件并从当前备份相册移除此项',
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Called only after exifOrientation has validated the TIFF header/IFD0.
  const little = bytes[0] === 73;
  const root = view.getUint32(4, little);
  const table = (offset: number) => {
    if (offset < 8 || offset > bytes.length - 2) return uncertain();
    const count = view.getUint16(offset, little);
    if (count > 512 || offset + 2 + count * 12 + 4 > bytes.length) return uncertain();
    return Array.from({ length: count }, (_, i) => offset + 2 + i * 12);
  };
  let makerSeen = false;
  const maker = (entry: number) => {
    if (makerSeen) return uncertain();
    makerSeen = true;
    const size = view.getUint32(entry + 4, little);
    const offset = view.getUint32(entry + 8, little);
    if (
      view.getUint16(entry + 2, little) !== 7 ||
      size < 16 ||
      offset < 8 ||
      offset > bytes.length - size
    )
      return uncertain();
    const note = bytes.subarray(offset, offset + size);
    if (!Array.from('Apple iOS\0').every((c, i) => note[i] === c.charCodeAt(0))) return uncertain();
    // Only the documented v1 header and explicit byte order are supported.
    if (note[10] !== 0 || note[11] !== 1) return uncertain();
    const order = String.fromCharCode(note[12]!, note[13]!);
    if (order !== 'II' && order !== 'MM') return uncertain();
    const v = new DataView(note.buffer, note.byteOffset, note.byteLength);
    const le = order === 'II';
    const count = v.getUint16(14, le);
    const end = 16 + count * 12;
    if (count > 256 || end > size) return uncertain();
    for (let i = 0; i < count; i++) {
      const tag = v.getUint16(16 + i * 12, le);
      // Presence is sufficient: malformed/empty identifiers must not bypass rejection.
      if (tag === 0x11 || tag === 0x17) {
        if (!identified) return live();
        if (tag === 0x17) {
          identified(null);
          continue;
        }
        const entry = 16 + i * 12;
        const type = v.getUint16(entry + 2, le),
          length = v.getUint32(entry + 4, le);
        const start = length <= 4 ? entry + 8 : v.getUint32(entry + 8, le);
        if (type !== 2 || length < 2 || length > 256 || start > note.length - length)
          return uncertain();
        const id = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
          .decode(note.subarray(start, start + length))
          .replace(/\0$/, '');
        if (!/^[a-zA-Z0-9-]{8,128}$/.test(id)) return uncertain();
        identified(id);
      }
    }
    // Do not silently ignore a chained MakerNote IFD.
    if (end + 4 <= size && v.getUint32(end, le) !== 0) return uncertain();
  };
  let sub: number | undefined;
  for (const entry of table(root)) {
    const tag = view.getUint16(entry, little);
    if (tag === 0x927c) maker(entry);
    if (tag === 0x8769) {
      if (
        sub !== undefined ||
        view.getUint16(entry + 2, little) !== 4 ||
        view.getUint32(entry + 4, little) !== 1
      )
        return uncertain();
      sub = view.getUint32(entry + 8, little);
      if (sub === root) return uncertain();
    }
  }
  if (sub !== undefined) {
    const entries = table(sub);
    if (view.getUint32(sub + 2 + entries.length * 12, little) !== 0) return uncertain();
    for (const entry of entries) {
      const tag = view.getUint16(entry, little);
      if (tag === 0x8769) return uncertain();
      if (tag === 0x927c) maker(entry);
    }
  }
}
