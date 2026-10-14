import { readFile, writeFile } from 'node:fs/promises';
import { assessCpu, correlateCpu, summarizeCpu } from './budget-metrics.mjs';
const version = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(version ?? ''))
  throw new Error('version: pass the deployed Worker version UUID');
const probe = JSON.parse(await readFile('work/budget-probe.json', 'utf8'));
// This file must contain only whitelisted fields from the telemetry query, never raw events/headers.
const platform = JSON.parse(await readFile('work/budget-platform.json', 'utf8'));
if (!platform.success || !Array.isArray(platform.samples))
  throw new Error('platform: successful telemetry result required');
const samples = correlateCpu(probe, platform.samples, version);
const report = {
  checkedAt: new Date().toISOString(),
  version,
  source:
    'Cloudflare Workers invocation cpuTimeMs/wallTimeMs, correlated by CF-Ray, version and status',
  accountPlan: 'unverified-subscriptions-api-authentication-error',
  samples,
  assessment: assessCpu(samples),
  snapshot: summarizeCpu(samples.filter((s) => /^snapshot(?:-\d+)?$/.test(s.name))),
  incremental: summarizeCpu(samples.filter((s) => /^incremental(?:-\d+)?$/.test(s.name))),
  fullGo: false,
};
await writeFile('work/budget-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.assessment));
