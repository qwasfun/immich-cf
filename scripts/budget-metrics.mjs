// Wall time is deliberately excluded: it cannot substitute for platform CPU time.
export function summarizeCpu(samples) {
  const values = samples
    .map((s) => s.cpuMs)
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  return {
    ...assessCpu(samples),
    minCpuMs: values[0] ?? null,
    medianCpuMs: values.length
      ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2
      : null,
    p95CpuMs: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
    percentileMethod: 'nearest-rank; measured samples only; not a population guarantee',
  };
}

export function assessCpu(samples, thresholdMs = 10) {
  if (!Array.isArray(samples) || !samples.length) return { decision: 'unverified', count: 0 };
  const valid = samples.filter(
    (s) => typeof s.cpuMs === 'number' && Number.isFinite(s.cpuMs) && s.cpuMs >= 0,
  );
  const exceeded = valid.filter((s) => s.cpuMs > thresholdMs).length;
  return {
    decision: exceeded
      ? 'no-go-current-free-cpu'
      : valid.length !== samples.length
        ? 'unverified'
        : 'sample-within-budget-not-full-go',
    count: samples.length,
    measured: valid.length,
    missing: samples.length - valid.length,
    thresholdMs,
    maxCpuMs: valid.length ? Math.max(...valid.map((s) => s.cpuMs)) : null,
    exceeded,
  };
}
export function correlateCpu(probe, samples, version) {
  return probe.steps.map((step) => {
    const matches = samples.filter(
      (s) =>
        s.requestId === step.requestId &&
        s.script === 'immich-cf-api-dev' &&
        s.version === version &&
        s.status === step.status,
    );
    const sample = matches.length === 1 ? matches[0] : {};
    return {
      name: step.name,
      status: step.status,
      cpuMs: sample.cpuMs ?? null,
      wallMs: sample.wallMs ?? null,
      outcome: sample.outcome ?? null,
    };
  });
}
