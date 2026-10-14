// Wall time is deliberately excluded: it cannot substitute for platform CPU time.
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
