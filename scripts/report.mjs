import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { buildRunSummary, upsertRun } from './lib/runs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(root, 'results');
const reportsDir = path.join(root, 'reports');
const runsPath = path.join(resultsDir, 'history', 'runs.json');
const args = parseArgs(process.argv.slice(2));

const SCENARIO_DESC = {
  'warm-install': 'Steady-state install: Verdaccio storage and npm cache pre-warmed, fresh project each sample.',
  'proxy-install': 'Cold cache-miss: empty storage + empty npm cache each sample, forcing proxy fetch + store + serve.',
  publish: 'Time for `npm publish` of a small package (new version each sample).',
  unpublish: 'Time for `npm unpublish --force` (version published untimed beforehand).',
};

const inputPath = args.input ? path.resolve(args.input) : await latestBenchJson();
const data = JSON.parse(await readFile(inputPath, 'utf8'));
const outputPath = args.output
  ? path.resolve(args.output)
  : path.join(reportsDir, `${path.basename(inputPath, '.json')}.html`);

await mkdir(reportsDir, { recursive: true });
await writeFile(outputPath, renderHtml(data), 'utf8');
console.log(path.relative(root, outputPath));

// Record this run in the committed digest so the dashboard can track progress.
if (data.runId && !args['no-index']) {
  const count = await upsertRun(runsPath, buildRunSummary(data));
  console.log(`${path.relative(root, runsPath)} (${count} runs)`);
}

async function latestBenchJson() {
  const files = await readdir(resultsDir);
  const candidates = files
    .filter((file) => file.startsWith('bench-') && file.endsWith('.json'))
    .sort()
    .reverse();
  if (candidates.length === 0) throw new Error(`No bench-*.json found in ${resultsDir}`);
  return path.join(resultsDir, candidates[0]);
}

function renderHtml(data) {
  const timingRows = data.summary.filter((row) => row.unit === 'ms');
  const serveRows = data.summary.filter((row) => row.unit === 'throughput');
  const scenarioOrder = [...new Set(timingRows.map((r) => r.scenario))];

  const timingSections = scenarioOrder
    .map((scenario) => renderTimingSection(scenario, timingRows.filter((r) => r.scenario === scenario)))
    .join('\n');

  const serveSection = serveRows.length ? renderServeSection(serveRows, data.rows) : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noai, noimageai">
  <title>Verdaccio benchmark</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f8f4; --panel: #fff; --text: #1f2933; --muted: #5b6673;
      --line: #d7dcca; --accent: #0f766e; --bar: #7c3aed; --head: #eef1e8;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #14181c; --panel: #1c2127; --text: #e6e9ec; --muted: #9aa4af;
        --line: #2c333b; --accent: #4fd1c5; --bar: #a78bfa; --head: #232a31;
      }
    }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { width: min(1080px, calc(100% - 32px)); margin: 40px auto; }
    h1 { margin: 0 0 4px; font-size: 30px; }
    h2 { margin: 40px 0 6px; font-size: 20px; }
    .meta { color: var(--muted); line-height: 1.6; margin-bottom: 8px; }
    .desc { color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
    .env { display: flex; flex-wrap: wrap; gap: 8px 20px; color: var(--muted); font-size: 13px; margin: 12px 0 8px; }
    .tablewrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); }
    th, td { padding: 10px 12px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
    th:first-child, td:first-child { text-align: left; }
    th { font-size: 12px; color: var(--muted); background: var(--head); }
    tr:last-child td { border-bottom: 0; }
    .best { color: var(--accent); font-weight: 700; }
    .bars { display: grid; gap: 10px; margin-top: 14px; }
    .bar-row { display: grid; grid-template-columns: 130px 1fr 90px; gap: 12px; align-items: center; }
    .track { height: 12px; background: var(--head); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
    .fill { height: 100%; background: var(--bar); }
    code { background: var(--head); padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Verdaccio benchmark</h1>
    <div class="meta">Run <code>${escapeHtml(data.runId)}</code> · ${data.samples} samples${
      data.warmup != null ? ` (+${data.warmup} warmup)` : ''
    } · upstream <code>${escapeHtml(data.upstream?.mode ?? 'unknown')}</code></div>
    ${renderEnv(data.env, data.versions)}
    ${timingSections}
    ${serveSection}
    <p class="desc" style="margin-top:32px">Lower is better for timings; higher req/s is better for serving. Best value per scenario is highlighted. Results are only comparable within one environment snapshot.</p>
  </main>
</body>
</html>
`;
}

function renderEnv(env = {}, versions = {}) {
  const versionList = Object.entries(versions)
    .map(([label, version]) => `${escapeHtml(label)}=<code>${escapeHtml(version)}</code>`)
    .join(' · ');
  return `<div class="env">
    <span>${versionList}</span>
    <span>node ${escapeHtml(env.node ?? '?')}</span>
    <span>npm ${escapeHtml(env.npm ?? '?')}</span>
    <span>${escapeHtml(env.os?.platform ?? '?')} ${escapeHtml(env.os?.arch ?? '')}</span>
    <span>${escapeHtml(env.cpu?.model ?? '?')} (${env.cpu?.cores ?? '?'} cores)</span>
  </div>`;
}

function renderTimingSection(scenario, rows) {
  const fastest = Math.min(...rows.map((r) => r.medianMs ?? Infinity));
  const maxMedian = Math.max(...rows.map((r) => r.medianMs ?? 0));
  const body = rows
    .map(
      (r) => `<tr>
      <td>${escapeHtml(r.versionLabel)} <span class="env" style="display:inline">(${escapeHtml(r.version)})</span></td>
      <td>${r.samples ?? '-'}</td>
      <td class="${r.medianMs === fastest ? 'best' : ''}">${ms(r.medianMs)}</td>
      <td>${ms(r.p90Ms)}</td>
      <td>${ms(r.p95Ms)}</td>
      <td>${ms(r.minMs)}</td>
      <td>${ms(r.maxMs)}</td>
      <td>${ms(r.stddevMs)}</td>
    </tr>`
    )
    .join('');
  const bars = rows
    .map(
      (r) => `<div class="bar-row">
      <div>${escapeHtml(r.versionLabel)}</div>
      <div class="track"><div class="fill" style="width:${maxMedian ? Math.round(((r.medianMs ?? 0) / maxMedian) * 100) : 0}%"></div></div>
      <div>${ms(r.medianMs)}</div>
    </div>`
    )
    .join('');

  return `<h2>${escapeHtml(scenario)}</h2>
  <p class="desc">${escapeHtml(SCENARIO_DESC[scenario] ?? '')}</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Version</th><th>Samples</th><th>Median</th><th>p90</th><th>p95</th><th>Min</th><th>Max</th><th>Stddev</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <div class="bars">${bars}</div>`;
}

function renderServeSection(serveRows, rawRows) {
  // Flatten (version, endpoint) pairs from the raw rows' extra payloads.
  const flat = [];
  for (const summary of serveRows) {
    const raw = rawRows.find((r) => r.scenario === 'serve' && r.versionLabel === summary.versionLabel);
    for (const e of raw?.extra?.endpoints ?? []) {
      flat.push({ version: summary.versionLabel, resolved: summary.version, ...e });
    }
  }
  const endpoints = [...new Set(flat.map((f) => f.endpoint))];

  const sections = endpoints
    .map((endpoint) => {
      const rows = flat.filter((f) => f.endpoint === endpoint);
      const bestRps = Math.max(...rows.map((r) => r.requestsPerSecond ?? 0));
      const body = rows
        .map(
          (r) => `<tr>
          <td>${escapeHtml(r.version)}</td>
          <td class="${r.requestsPerSecond === bestRps ? 'best' : ''}">${num(r.requestsPerSecond)}</td>
          <td>${num(r.latencyMs?.p50)}</td>
          <td>${num(r.latencyMs?.p95)}</td>
          <td>${num(r.latencyMs?.p99)}</td>
          <td>${r.failedRequests ?? 0}</td>
        </tr>`
        )
        .join('');
      return `<h2>serve · ${escapeHtml(endpoint)}</h2>
      <div class="tablewrap"><table>
        <thead><tr><th>Version</th><th>Req/s</th><th>p50 (ms)</th><th>p95 (ms)</th><th>p99 (ms)</th><th>Failed</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>`;
    })
    .join('\n');

  return `<h2 style="margin-bottom:0">Server isolation (ab)</h2>
  <p class="desc">Raw HTTP throughput against pre-warmed storage, bypassing npm. Higher req/s is better.</p>
  ${sections}`;
}

function ms(value) {
  return value == null ? '-' : `${value >= 1000 ? (value / 1000).toFixed(2) + 's' : Math.round(value) + 'ms'}`;
}
function num(value) {
  return value == null ? '-' : Math.round(value).toLocaleString('en-US');
}
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
