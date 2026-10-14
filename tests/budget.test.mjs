import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCpu } from '../scripts/budget-metrics.mjs';
test('CPU gate does not interpret missing values or wall time as zero CPU', () => {
  assert.equal(assessCpu([]).decision, 'unverified');
  for (const cpuMs of [null, undefined, '0', NaN, Infinity, -1])
    assert.equal(assessCpu([{ cpuMs, wallMs: 1 }]).decision, 'unverified');
  assert.equal(assessCpu([{ cpuMs: 2 }, {}]).decision, 'unverified');
});
test('CPU gate reports over-budget samples without weakening authentication or claiming full Go', () => {
  assert.equal(assessCpu([{ cpuMs: 10 }]).decision, 'sample-within-budget-not-full-go');
  assert.equal(assessCpu([{ cpuMs: 10.1 }, {}]).decision, 'no-go-current-free-cpu');
  assert.deepEqual(assessCpu([{ cpuMs: 0 }, { cpuMs: 250 }]), {
    decision: 'no-go-current-free-cpu',
    count: 2,
    measured: 2,
    missing: 0,
    thresholdMs: 10,
    maxCpuMs: 250,
    exceeded: 1,
  });
});

test('CPU correlation rejects other versions, mismatched status and ambiguous duplicate events; exports allowlist only', async () => {
  const { correlateCpu } = await import('../scripts/budget-metrics.mjs');
  const probe = { steps: [{ name: 'login', status: 201, requestId: 'ray' }] };
  const event = {
    requestId: 'ray',
    script: 'immich-cf-api-dev',
    version: 'v1',
    status: 201,
    cpuMs: 300,
    wallMs: 400,
    outcome: 'ok',
    secret: 'must-not-export',
  };
  assert.equal(correlateCpu(probe, [event], 'v2')[0].cpuMs, null);
  assert.equal(correlateCpu(probe, [{ ...event, status: 401 }], 'v1')[0].cpuMs, null);
  assert.equal(correlateCpu(probe, [event, event], 'v1')[0].cpuMs, null);
  assert.deepEqual(correlateCpu(probe, [event], 'v1'), [
    { name: 'login', status: 201, cpuMs: 300, wallMs: 400, outcome: 'ok' },
  ]);
});
