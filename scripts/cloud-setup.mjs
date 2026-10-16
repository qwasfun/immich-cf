import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { packageManager } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const expectedPnpm = packageManager.split('@')[1];
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 9) {
  throw new Error('Node.js：需要 24.9.0～24.x，请按 .node-version 配置云端运行时');
}

function run(command, args, capture = false) {
  // These commands and arguments are fixed literals, never user input.
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? 'cmd.exe' : command,
    windows ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args,
    {
      stdio: capture ? 'pipe' : 'inherit',
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`${command}：执行失败，请检查工具安装和依赖下载网络`);
  }
  return result.stdout?.trim();
}

if (run('pnpm', ['--version'], true) !== expectedPnpm) {
  throw new Error(`pnpm：需要 ${expectedPnpm}，请按 packageManager 配置云端包管理器`);
}
run('curl', ['--version'], true);
run('pnpm', ['install', '--frozen-lockfile']);
run('pnpm', ['cloud:db:migrate']);
run('pnpm', ['types']);
console.log('云端准备完成：依赖、纯本地数据库迁移和类型已就绪。请继续运行 pnpm cloud:check。');
