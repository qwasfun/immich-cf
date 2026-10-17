import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import bcrypt from 'bcryptjs';
import { getPlatformProxy, unstable_dev } from 'wrangler';
import { loadCorpus, corpusSummary, CorpusError, requireCorpus } from './lib/real-media-corpus.mjs';
import { verifyCorpus, localCorpusTransport } from './lib/real-media-runner.mjs';
let worker,
  platform,
  entries = [],
  complete = false,
  failure = null;
const results = new Map(),
  metrics = [];
const reportFile = path.resolve('work/real-media-report.json');
const state = path.resolve('work', `real-media-${crypto.randomUUID()}`);
const report = async () => {
  await mkdir('work', { recursive: true });
  return writeFile(
    reportFile,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope: 'isolated-local-corpus',
        complete,
        failure,
        results: [...results.values()],
        summary: corpusSummary(entries, [...results.values()]),
        metrics,
        remoteUpload: false,
        privateFilenamesExported: false,
      },
      null,
      2,
    ),
  );
};
try {
  const args = process.argv.slice(2);
  requireCorpus(
    args.length === 0 || (args.length === 2 && args[0] === '--manifest'),
    'arguments',
    '仅支持 --manifest 清单路径；无参数时使用默认私人样本目录',
  );
  await mkdir('work', { recursive: true });
  entries = await loadCorpus(
    path.resolve(args[1] ?? 'tests/private-fixtures/real-media/manifest.json'),
  );
  const require = createRequire(import.meta.url);
  const cli = path.resolve(path.dirname(require.resolve('wrangler')), '../bin/wrangler.js');
  execFileSync(
    process.execPath,
    [
      cli,
      'd1',
      'migrations',
      'apply',
      'IMMICH_CF_DB',
      '--env',
      'dev',
      '--local',
      '--persist-to',
      state,
    ],
    { stdio: 'pipe' },
  );
  platform = await getPlatformProxy({
    configPath: 'wrangler.json',
    environment: 'dev',
    persist: { path: path.join(state, 'v3') },
    remoteBindings: false,
  });
  worker = await unstable_dev('src/index.ts', {
    config: 'wrangler.json',
    env: 'dev',
    local: true,
    ip: '127.0.0.1',
    port: 0,
    persist: true,
    persistTo: state,
    vars: { ENABLE_P1_POC: 'true' },
    experimental: { disableExperimentalWarning: true, forceLocal: true, watch: false },
  });
  const password = crypto.randomUUID() + '-local-only',
    passwordHash = await bcrypt.hash(password, 12);
  const transport = localCorpusTransport(`http://${worker.address}:${worker.port}`, async (m) => {
    metrics.push(m);
  });
  const account = async () => {
    const id = crypto.randomUUID(),
      email = `${id}@example.invalid`;
    await platform.env.IMMICH_CF_DB.prepare(
      'INSERT INTO users (id,email,name,password_hash,created_at,update_id) VALUES (?,?,?,?,?,?)',
    )
      .bind(id, email, '本地样本验收', passwordHash, new Date().toISOString(), crypto.randomUUID())
      .run();
    const login = await transport.json('/api/auth/login', { email, password });
    requireCorpus(login.status === 201, 'login', '本地测试账户登录失败，请保留隔离测试状态后重试');
    return JSON.parse(login.bytes).accessToken;
  };
  await verifyCorpus(entries, {
    transport,
    account,
    onResult: async (r) => {
      results.set(r.index, r);
      await report();
    },
  });
  complete = true;
} catch (error) {
  complete = false;
  failure =
    error instanceof CorpusError
      ? { field: error.field, message: error.message }
      : {
          field: 'manifest/runtime',
          message:
            '清单或隔离测试环境：无法完成验收，请确认文件可读、Node/pnpm 版本和本地服务权限后重试',
        };
  failure.cleanupUnconfirmed = !!error?.cleanupUnconfirmed;
  process.exitCode = 1;
} finally {
  try {
    await worker?.stop();
  } catch {
    complete = false;
    failure ??= { field: 'runtime', message: '本地服务：关闭未确认，请检查本机进程' };
    process.exitCode = 1;
  }
  try {
    await platform?.dispose();
  } catch {
    complete = false;
    failure ??= { field: 'runtime', message: '本地存储：关闭未确认，请检查本机进程' };
    process.exitCode = 1;
  }
  await report();
  console.log(
    JSON.stringify({
      complete,
      failure,
      summary: corpusSummary(entries, [...results.values()]),
      report: 'work/real-media-report.json',
    }),
  );
}
