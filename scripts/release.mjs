import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const target = process.argv[2];
if (!['dev', 'test', 'prod'].includes(target)) throw new Error('环境：必须选择 dev、test 或 prod');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('branch', '--show-current') !== target)
  throw new Error(`分支：请先切换到 ${target}，并完成前一环境的合并与验收`);
if (git('status', '--porcelain')) throw new Error('工作区：请先提交变更，发布只能使用干净提交');
const config = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url)));
const environment = config.env[target];
if (environment.d1_databases.some((binding) => binding.database_id.startsWith('00000000-')))
  throw new Error(`${target} 数据库：尚未创建独立资源，请填写真实 ID 后再发布`);
const upstream = { test: 'dev', prod: 'test' }[target];
if (upstream) {
  // 晋升提交须已在前一环境分支中存在；不在发布脚本里自动合并未知变更。
  let source = upstream;
  try {
    git('rev-parse', '--verify', upstream);
  } catch {
    source = `origin/${upstream}`;
  }
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', source]);
}
const wrangler = path.resolve(path.dirname(require.resolve('wrangler')), '../bin/wrangler.js');
const run = (args) => execFileSync(process.execPath, [wrangler, ...args], { stdio: 'inherit' });
console.log(
  `发布环境 ${target}，提交 ${git('rev-parse', 'HEAD')}。数据仅应用本环境迁移，不复制其它环境数据。`,
);
run(['d1', 'migrations', 'apply', 'IMMICH_CF_DB', '--env', target, '--remote']);
run(['deploy', '--env', target]);
