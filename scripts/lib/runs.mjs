import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Compact, committed per-run summary that powers the dashboard's runs-by-date
// list and progress-over-time charts. The full bench-*.json stay gitignored;
// only this small digest is version-controlled so progress accumulates.

export function buildRunSummary(data) {
  const metrics = [];
  for (const s of data.summary ?? []) {
    if (s.unit === 'ms') {
      metrics.push({ scenario: s.scenario, versionLabel: s.versionLabel, version: s.version, medianMs: s.medianMs ?? null });
    }
  }
  // serve is throughput-shaped: carry the tarball endpoint's p50 latency (to line
  // up with the 2021-2023 archive) and its req/s.
  for (const row of (data.rows ?? []).filter((r) => r.scenario === 'serve')) {
    const tb = row.extra?.endpoints?.find((e) => e.endpoint === 'tarball');
    metrics.push({
      scenario: 'serve',
      versionLabel: row.versionLabel,
      version: row.version,
      serveTarballP50Ms: tb?.latencyMs?.p50 ?? null,
      serveTarballReqPerSec: tb?.requestsPerSecond ?? null,
    });
  }

  return {
    runId: data.runId,
    date: data.env?.capturedAt ?? new Date(0).toISOString(),
    env: {
      node: data.env?.node ?? null,
      npm: data.env?.npm ?? null,
      cpu: data.env?.cpu?.model ?? null,
      cores: data.env?.cpu?.cores ?? null,
      platform: data.env?.os?.platform ?? null,
      arch: data.env?.os?.arch ?? null,
    },
    versions: data.versions ?? {},
    scenarios: [...new Set(metrics.map((m) => m.scenario))],
    report: `bench-${data.runId}.html`,
    metrics,
  };
}

// Insert-or-replace by runId, keep sorted by date ascending.
export async function upsertRun(runsPath, summary) {
  await mkdir(path.dirname(runsPath), { recursive: true });
  const existing = await readFile(runsPath, 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => ({ runs: [] }));
  const runs = (existing.runs ?? []).filter((r) => r.runId !== summary.runId);
  runs.push(summary);
  runs.sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(runsPath, JSON.stringify({ runs }, null, 2), 'utf8');
  return runs.length;
}

export async function readRuns(runsPath) {
  return readFile(runsPath, 'utf8')
    .then((raw) => JSON.parse(raw).runs ?? [])
    .catch(() => []);
}
