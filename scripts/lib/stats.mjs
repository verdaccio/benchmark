// Nearest-rank percentile over an unsorted numeric array.
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export function summarizeSamples(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mean = clean.reduce((sum, v) => sum + v, 0) / clean.length;
  return {
    samples: clean.length,
    meanMs: round(mean),
    medianMs: round(percentile(sorted, 50)),
    p90Ms: round(percentile(sorted, 90)),
    p95Ms: round(percentile(sorted, 95)),
    minMs: round(sorted[0]),
    maxMs: round(sorted.at(-1)),
    stddevMs: round(stddev(clean, mean)),
  };
}

function stddev(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function round(value) {
  return value == null ? null : Math.round(value * 100) / 100;
}
