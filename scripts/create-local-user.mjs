import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

// 从 stdin 接收，避免密码出现在命令参数或日志。仅生成本地导入文件，不操作远程账户。
let data;
try {
  data = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  throw new Error('输入：请通过标准输入提供包含 email、name、password 的 JSON 对象');
}
if (!data || typeof data !== 'object' || Array.isArray(data)) {
  throw new Error('输入：必须为包含 email、name、password 的 JSON 对象');
}
if (
  typeof data.email !== 'string' ||
  data.email.length > 254 ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())
)
  throw new Error('email：请填写有效邮箱，最多 254 字符');
if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80)
  throw new Error('name：请填写 1～80 字符的名称');
if (
  typeof data.password !== 'string' ||
  data.password.length < 15 ||
  bcrypt.truncates(data.password)
)
  throw new Error('password：至少 15 字符，且 UTF-8 编码后最多 72 字节');
const hash = await bcrypt.hash(data.password, 12);
const now = new Date().toISOString();
const prefix = Date.now().toString(16).padStart(12, '0');
const random = randomUUID();
const updateId = `${prefix.slice(0, 8)}-${prefix.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
const quote = (v) => `'${v.replaceAll("'", "''")}'`;
const values = [
  randomUUID(),
  data.email.trim().toLowerCase(),
  data.name.trim(),
  hash,
  now,
  updateId,
];
const out = new URL('../work/local-user.sql', import.meta.url);
mkdirSync(new URL('../work/', import.meta.url), { recursive: true });
writeFileSync(
  out,
  `INSERT INTO users (id,email,name,password_hash,created_at,update_id) VALUES (${values.map(quote).join(',')});\n`,
  { mode: 0o600 },
);
console.log('已生成 work/local-user.sql（包含邮箱与密码哈希，不得提交）。请仅导入本地 D1。');
