// Shared local/public boundary fixtures; no private photos or device identifiers.
export function metadataBytes(size) {
  const wrap = (cloudId) => JSON.stringify([{ key: 'mobile-app', value: { cloudId } }]);
  const overhead = Buffer.byteLength(wrap(''));
  return wrap('汉'.repeat(Math.floor((size - overhead) / 3)) + 'a'.repeat((size - overhead) % 3));
}
export function uploadFieldCases() {
  return [
    { name: 'metadata-utf8-over', fields: { metadata: metadataBytes(8193) }, field: 'metadata' },
    { name: 'ignored-text-over', fields: { extra: '汉'.repeat(2731) }, field: 'extra' },
    {
      name: 'text-total-over',
      fields: { metadata: metadataBytes(8192), extra: 'a'.repeat(8192) },
      field: '上传文本字段',
    },
    {
      name: 'too-many-fields',
      fields: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`extra${i}`, ''])),
      field: '上传表单',
    },
    {
      name: 'extra-file',
      fields: { extra: new File(['PRIVATE_VALUE'], 'extra.bin') },
      field: 'extra',
    },
    {
      name: 'text-as-file',
      fields: { filename: new File(['PRIVATE_VALUE'], 'extra.bin') },
      field: 'filename',
    },
    { name: 'long-key', fields: { ['汉'.repeat(43)]: 'PRIVATE_VALUE' }, field: '上传字段名' },
    // workerd rejects an empty multipart name before exposing parsed fields.
    { name: 'empty-key', fields: { '': 'PRIVATE_VALUE' }, field: 'assetData' },
  ];
}
