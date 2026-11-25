import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyReleaseBranch } from '../scripts/lib/release-branch.mjs';

test('维护者生产发布要求 main 的干净提交已经过 test', (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'release-branch-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  git('commit', '--allow-empty', '-m', 'tested');
  const tested = git('rev-parse', 'HEAD');
  git('branch', 'test');
  assert.equal(verifyReleaseBranch('prod', cwd), tested);
  git('switch', '-c', 'prod');
  assert.throws(() => verifyReleaseBranch('prod', cwd), /main 分支/);
  git('switch', 'main');
  git('update-ref', 'refs/remotes/origin/test', tested);
  git('branch', '-d', 'test');
  assert.equal(verifyReleaseBranch('prod', cwd), tested);
  git('commit', '--allow-empty', '-m', 'untested');
  assert.throws(() => verifyReleaseBranch('prod', cwd), /test 分支晋升检查/);
  writeFileSync(path.join(cwd, 'dirty'), 'dirty');
  assert.throws(() => verifyReleaseBranch('prod', cwd), /干净提交/);
});
