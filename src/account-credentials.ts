import bcrypt from 'bcryptjs';

export function validAccountEmail(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  );
}

export function validAccountPassword(value: unknown): value is string {
  return typeof value === 'string' && Array.from(value).length >= 15 && !bcrypt.truncates(value);
}
