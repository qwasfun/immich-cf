import { crc32 } from 'node:zlib';

// Header-only synthetic variants: deliberately NOT pixel-decodable golden images.
export function withDimensions(source, width, height, format) {
  const bytes = Buffer.from(source);
  if (format === 'png') {
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
    return bytes;
  }
  let offset = 2;
  while (offset + 4 < bytes.length) {
    const marker = bytes[offset + 1];
    if (marker === 192 || marker === 194) {
      bytes.writeUInt16BE(height, offset + 5);
      bytes.writeUInt16BE(width, offset + 7);
      return bytes;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error('Synthetic JPEG fixture has no SOF');
}
