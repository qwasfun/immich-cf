// Trust R2's native checksum, never caller-controlled custom metadata or ETag-as-SHA1.
export function originalMatches(
  object: R2Object | null,
  bytes: number,
  checksum: string,
  required: boolean,
): boolean {
  if (!object || object.size !== bytes) return false;
  const sha1 = object.checksums.sha1;
  if (!sha1) return !required;
  return btoa(String.fromCharCode(...new Uint8Array(sha1))) === checksum;
}
