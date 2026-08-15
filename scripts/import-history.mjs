import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';

// Rescue the 2021-2023 Verdaccio serve benchmarks (packument "info" + tarball)
// from the old Next.js benchmark repo into one durable, app-independent dataset.
// Each historical run measured raw HTTP serving with hyperfine (latency) and
// autocannon (throughput); we merge both per version+endpoint.
//
// Usage: node scripts/import-history.mjs --src /path/to/verdaccio-benchmark

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const srcRoot = path.resolve(args.src ?? '/Users/verdaccio/projects/verdaccio-benchmark');
const runsDir = path.join(srcRoot, 'benchmark');
const outDir = path.join(root, 'results', 'history');

const runDirs = (await readdir(runsDir).catch(() => []))
  .filter((name) => /^\d+$/.test(name))
  .sort((a, b) => Number(a) - Number(b));

if (runDirs.length === 0) {
  throw new Error(`No timestamped run dirs under ${runsDir}. Pass --src <old-repo-path>.`);
}

const records = [];
let skipped = 0;

for (const ts of runDirs) {
  const runPath = path.join(runsDir, ts);
  const hyperDir = path.join(runPath, 'hyperfine');
  const autoDir = path.join(runPath, 'autocannon');

  const hyperFiles = await readdir(hyperDir).catch(() => []);
  const autoFiles = await readdir(autoDir).catch(() => []);

  // Discover every (version, endpoint) pair present in either tool's output.
  const keys = new Map(); // "version|endpoint" -> { version, endpoint }
  for (const f of hyperFiles) {
    const m = f.match(/^hyper-results-(.+)-(info|tarball)\.json$/);
    if (m) keys.set(`${m[1]}|${m[2]}`, { version: m[1], endpoint: m[2] });
  }
  for (const f of autoFiles) {
    const m = f.match(/^api-results-(.+)-(info|tarball)\.json$/);
    if (m) keys.set(`${m[1]}|${m[2]}`, { version: m[1], endpoint: m[2] });
  }

  for (const { version, endpoint } of keys.values()) {
    const latency = await readHyperfine(path.join(hyperDir, `hyper-results-${version}-${endpoint}.json`));
    const server = await readAutocannon(path.join(autoDir, `api-results-${version}-${endpoint}.json`));
    if (!latency && !server) {
      skipped += 1;
      continue;
    }
    records.push({
      ts: Number(ts),
      date: new Date(Number(ts)).toISOString(),
      version,
      major: majorOf(version),
      endpoint, // "info" (packument) | "tarball"
      // The historical suite switched what it timed over the years: early runs
      // timed npm CLI ops (`npm info/install jquery`, seconds); later runs timed
      // raw HTTP (`curl localhost/...`, ms). Keep them distinguishable so a trend
      // never mixes the two regimes.
      method: methodOf(latency?.command),
      command: latency?.command ?? null,
      latencyMs: latency ? omit(latency, 'command') : null,
      server, // autocannon HTTP throughput (later era only)
    });
  }
}

records.sort((a, b) => a.ts - b.ts);

await mkdir(outDir, { recursive: true });
const summary = summarize(records);
const payload = {
  source: srcRoot,
  importedRuns: runDirs.length,
  records: records.length,
  dateRange: records.length ? { from: records[0].date, to: records.at(-1).date } : null,
  versions: [...new Set(records.map((r) => r.version))].sort(),
  summary,
  data: records,
};

await writeFile(path.join(outDir, 'history.json'), JSON.stringify(payload, null, 2), 'utf8');
await writeFile(path.join(outDir, 'history.csv'), toCsv(records), 'utf8');

console.log(`Imported ${records.length} records from ${runDirs.length} runs (${skipped} empty pairs skipped).`);
console.log(`Versions: ${payload.versions.length}, range ${payload.dateRange?.from?.slice(0, 10)} -> ${payload.dateRange?.to?.slice(0, 10)}`);
console.log(`Wrote ${path.relative(root, path.join(outDir, 'history.json'))} and history.csv`);

// --- readers ---------------------------------------------------------------

async function readHyperfine(file) {
  const r = await readJson(file);
  const res = r?.results?.[0];
  if (!res) return null;
  // hyperfine times are in SECONDS; normalize to ms.
  const s = (v) => (typeof v === 'number' ? Math.round(v * 1000 * 1000) / 1000 : null);
  return {
    command: res.command ?? null,
    median: s(res.median),
    mean: s(res.mean),
    min: s(res.min),
    max: s(res.max),
    stddev: s(res.stddev),
    runs: Array.isArray(res.times) ? res.times.length : null,
  };
}

async function readAutocannon(file) {
  const r = await readJson(file);
  const res = r?.results?.[0];
  if (!res) return null;
  return {
    reqPerSec: round(res.requests?.average),
    latencyAvgMs: round(res.latency?.average),
    latencyP99Ms: round(res.latency?.p99),
    bytesPerSec: round(res.throughput?.average),
    non2xx: res.non2xx ?? null,
    errors: res.errors ?? null,
    durationSec: round(res.duration),
  };
}

async function readJson(file) {
  return readFile(file, 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
}

// --- helpers ---------------------------------------------------------------

function majorOf(version) {
  const m = version.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

// Classify what the latency number actually measured.
//   http    -> `curl ...localhost...` : raw HTTP serving (ms-scale)
//   npm-cli -> `npm info/install ...`  : full npm client op (seconds-scale)
function methodOf(command) {
  if (!command) return 'unknown';
  if (/^curl\b/.test(command)) return 'http';
  if (/^npm\b/.test(command)) return 'npm-cli';
  return 'other';
}

function omit(obj, key) {
  const { [key]: _, ...rest } = obj;
  return rest;
}

function round(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : null;
}

// Per-(version, endpoint) medians across all that version's runs, so the whole
// 2-year history collapses to one comparable row per version.
function summarize(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.version}|${r.endpoint}|${r.method}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const rows = [];
  for (const [key, group] of groups) {
    const [version, endpoint, method] = key.split('|');
    rows.push({
      version,
      major: majorOf(version),
      endpoint,
      method,
      runs: group.length,
      from: group[0].date.slice(0, 10),
      to: group.at(-1).date.slice(0, 10),
      medianLatencyMs: median(group.map((r) => r.latencyMs?.median)),
      medianReqPerSec: median(group.map((r) => r.server?.reqPerSec)),
      medianServerLatencyMs: median(group.map((r) => r.server?.latencyAvgMs)),
    });
  }
  return rows.sort(
    (a, b) => (a.major - b.major) || a.version.localeCompare(b.version) || a.endpoint.localeCompare(b.endpoint) || a.method.localeCompare(b.method)
  );
}

function median(values) {
  const clean = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (clean.length === 0) return null;
  return round(clean[Math.floor((clean.length - 1) / 2)]);
}

function toCsv(records) {
  const headers = ['ts', 'date', 'version', 'major', 'endpoint', 'latencyMedianMs', 'latencyMeanMs', 'reqPerSec', 'serverLatencyAvgMs', 'serverLatencyP99Ms', 'non2xx', 'errors'];
  const line = (r) =>
    [r.ts, r.date, r.version, r.major, r.endpoint, r.latencyMs?.median ?? '', r.latencyMs?.mean ?? '', r.server?.reqPerSec ?? '', r.server?.latencyAvgMs ?? '', r.server?.latencyP99Ms ?? '', r.server?.non2xx ?? '', r.server?.errors ?? '']
      .map((v) => JSON.stringify(v ?? ''))
      .join(',');
  return [headers.join(','), ...records.map(line), ''].join('\n');
}
