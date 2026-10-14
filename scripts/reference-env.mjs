import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const action = process.argv[2];
if (!['up', 'down'].includes(action)) throw new Error('操作：必须为 up 或 down');
mkdirSync('work', { recursive: true });
try {
  writeFileSync(
    'work/reference.env',
    `IMMICH_CF_REFERENCE_PASSWORD=${randomBytes(32).toString('hex')}\n`,
    { flag: 'wx', mode: 0o600 },
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
execFileSync(
  'docker',
  [
    'compose',
    '--env-file',
    'work/reference.env',
    '-f',
    'infra/reference/compose.yaml',
    ...(action === 'up' ? ['up', '-d', '--wait', '--wait-timeout', '180'] : ['down']),
  ],
  { stdio: 'inherit' },
);
