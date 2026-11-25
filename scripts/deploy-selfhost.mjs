import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import bcrypt from 'bcryptjs';
import { validAccountEmail, validAccountPassword } from '../src/account-credentials.ts';

const config = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url)));
const db = config.d1_databases[0];
const bucket = config.r2_buckets[0].bucket_name;
const cli = path.resolve(
  path.dirname(createRequire(import.meta.url).resolve('wrangler')),
  '../bin/wrangler.js',
);

function wrangler(args, { quiet = false } = {}) {
  const env = { ...process.env };
  delete env.INITIAL_ADMIN_EMAIL;
  delete env.INITIAL_ADMIN_PASSWORD;
  const result = spawnSync(process.execPath, [cli, ...args, '--env', ''], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'Wrangler 执行失败');
  if (!quiet) process.stdout.write(result.stdout);
  return result.stdout;
}

function preparePrivateBucket(run) {
  console.log('检查私有媒体桶，请确认账户已开通 R2 且构建令牌有 Workers R2 Storage Edit 权限');
  const devUrl = ['r2', 'bucket', 'dev-url', 'get', bucket];
  let access;
  try {
    access = run(devUrl, { quiet: true });
  } catch (error) {
    // Only NoSuchBucket means this is a new bucket. Authentication and network failures must stop deployment.
    if (!/\b10006\b/.test(error.message)) throw error;
    run(['r2', 'bucket', 'create', bucket, '--no-update-config']);
    access = run(devUrl, { quiet: true });
  }
  if (
    !access.includes('Public access via the r2.dev URL is disabled.') ||
    !run(['r2', 'bucket', 'domain', 'list', bucket], { quiet: true }).includes(
      'There are no custom domains connected to this bucket.',
    )
  )
    throw new Error('请在 R2 控制台确认自部署桶已关闭公共开发 URL，并移除公开自定义域名后重试');
}

async function initializeAdmin(settings, run) {
  const execute = ['d1', 'execute', db.binding, '--remote'];
  const result = JSON.parse(
    run([...execute, '--command', 'SELECT EXISTS(SELECT 1 FROM users) AS populated', '--json'], {
      quiet: true,
    }),
  );
  const populated = result[0]?.results?.[0]?.populated;
  if (populated === 1) return;
  if (populated !== 0) throw new Error('无法确认 D1 用户状态，请检查数据库后重试');
  if (!validAccountEmail(settings.INITIAL_ADMIN_EMAIL))
    throw new Error('请在构建变量 INITIAL_ADMIN_EMAIL 中填写有效邮箱');
  if (!validAccountPassword(settings.INITIAL_ADMIN_PASSWORD))
    throw new Error(
      '请在构建密钥 INITIAL_ADMIN_PASSWORD 中填写至少 15 个字符、UTF-8 最多 72 字节的密码',
    );
  const id = randomUUID();
  const now = new Date();
  const time = now.getTime().toString(16).padStart(12, '0');
  const updateId = time.slice(0, 8) + '-' + time.slice(8) + '-7' + id.slice(15);
  const email = settings.INITIAL_ADMIN_EMAIL.trim().toLowerCase().replaceAll("'", "''");
  const hash = await bcrypt.hash(settings.INITIAL_ADMIN_PASSWORD, 12);
  const directory = mkdtempSync(path.join(tmpdir(), 'immich-cf-admin-'));
  try {
    // Remote D1 imports are atomic. Both inserts become no-ops if another build won the race.
    const file = path.join(directory, 'admin.sql');
    writeFileSync(
      file,
      `INSERT INTO users(id,email,name,password_hash,created_at,update_id)
        SELECT '${id}','${email}','管理员','${hash}','${now.toISOString()}','${updateId}'
        WHERE NOT EXISTS (SELECT 1 FROM users);
        INSERT INTO operations_admins(user_id) SELECT id FROM users WHERE id='${id}';`,
      { mode: 0o600 },
    );
    run([...execute, '--file', file, '--yes'], { quiet: true });
  } catch {
    throw new Error('首次管理员写入失败，请检查 D1 权限及数据库状态后重试');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function deploySelfhost(settings, run = wrangler) {
  if (settings.WORKERS_CI !== '1' || settings.WORKERS_CI_BRANCH !== 'main')
    throw new Error('请在 Cloudflare Workers Builds 中选择 main 为生产分支');
  if (settings.WRANGLER_CI_OVERRIDE_NAME && settings.WRANGLER_CI_OVERRIDE_NAME !== config.name)
    throw new Error('请将控制台 Worker 名称设为 ' + config.name);
  if (!existsSync('dist/web/index.html'))
    throw new Error('缺少网页产物，请将构建命令设为 pnpm web:build');

  console.log('准备自部署数据库，请确认构建令牌有 D1 Edit 权限');
  const databases = JSON.parse(run(['d1', 'list', '--json'], { quiet: true }));
  if (!databases.some((item) => item.name === db.database_name))
    run(['d1', 'create', db.database_name, '--no-update-config']);

  preparePrivateBucket(run);

  console.log('应用 D1 迁移；修正失败原因后可在 Builds 中重试');
  run(['d1', 'migrations', 'apply', db.binding, '--remote']);
  await initializeAdmin(settings, run);

  const args = ['deploy'];
  if (settings.IMAGES_FREE_CONFIRMED === 'true') args.push('--var', 'IMAGES_FREE_CONFIRMED:true');
  run(args);
}

if (import.meta.main) {
  try {
    await deploySelfhost(process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
