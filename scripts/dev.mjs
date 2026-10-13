import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const cli = path.resolve(path.dirname(require.resolve('wrangler')), '../bin/wrangler.js');
// 当前网络握手间歇重置；进程级 TLS 1.2 兼容尝试，证书校验保持开启。
// 网络恢复后可直接 pnpm exec wrangler dev --env dev 使用默认 TLS 协商。
const child = spawn(process.execPath, [cli, 'dev', '--env', 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --tls-max-v1.2`.trim() },
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
child.on('error', () => {
  console.error('本地开发启动失败，请检查 Wrangler 安装与网络连接');
  process.exitCode = 1;
});
