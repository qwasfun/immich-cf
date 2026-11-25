import { execFileSync } from 'node:child_process';

export function verifyReleaseBranch(target, cwd = process.cwd()) {
  if (!['dev', 'test', 'prod'].includes(target))
    throw new Error('环境：必须选择 dev、test 或 prod');
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const branch = target === 'prod' ? 'main' : target;
  if (git('branch', '--show-current') !== branch)
    throw new Error(`发布 ${target} 环境请切换到 ${branch} 分支`);
  if (git('status', '--porcelain')) throw new Error('工作区：请先提交变更，发布只能使用干净提交');

  const upstream = { test: 'dev', prod: 'test' }[target];
  if (upstream) {
    let source = 'refs/heads/' + upstream;
    try {
      git('show-ref', '--verify', source);
    } catch {
      source = 'refs/remotes/origin/' + upstream;
    }
    try {
      git('merge-base', '--is-ancestor', 'HEAD', source);
    } catch {
      throw new Error(`当前提交未通过 ${upstream} 分支晋升检查，请核对并同步分支`);
    }
  }
  return git('rev-parse', 'HEAD');
}
