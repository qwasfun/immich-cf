import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { verifyReleaseBranch } from './lib/release-branch.mjs';
const require = createRequire(import.meta.url);
const target = process.argv[2];
const commit = verifyReleaseBranch(target);
const config = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url)));
const environment = config.env[target];
if (environment.d1_databases.some((binding) => binding.database_id.startsWith('00000000-')))
  throw new Error(`${target} 数据库：尚未创建独立资源，请填写真实 ID 后再发布`);
const wrangler = path.resolve(path.dirname(require.resolve('wrangler')), '../bin/wrangler.js');
const run = (args) => execFileSync(process.execPath, [wrangler, ...args], { stdio: 'inherit' });
// A release must contain the frontend built from the same checkout as the Worker.
execFileSync(
  process.execPath,
  [
    path.resolve(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
    'build',
    '--config',
    'web/vite.config.ts',
  ],
  { stdio: 'inherit' },
);
console.log(`发布环境 ${target}，提交 ${commit}。数据仅应用本环境迁移，不复制其它环境数据。`);
run(['d1', 'migrations', 'apply', 'IMMICH_CF_DB', '--env', target, '--remote']);
run(['deploy', '--env', target]);
