import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';

// Render the rescued 2021-2023 history as a trend report. The old suite changed
// what it timed over the years (npm CLI ops -> raw HTTP), so the two regimes are
// shown in separate sections and never plotted on one axis.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(args.input) : path.join(root, 'results', 'history', 'history.json');
const outputPath = args.output ? path.resolve(args.output) : path.join(root, 'reports', 'archive.html');

const data = JSON.parse(await readFile(inputPath, 'utf8'));

// Distinct colors per version (colorblind-friendly, works light + dark).
const PALETTE = ['#0f766e', '#7c3aed', '#c2410c', '#0369a1', '#65a30d', '#be123c', '#a16207', '#4f46e5', '#0891b2', '#db2777'];
const versionColor = new Map(data.versions.map((v, i) => [v, PALETTE[i % PALETTE.length]]));

const ERAS = [
  { method: 'http', title: 'HTTP serving era (curl → localhost)', unit: 'ms', note: 'Raw HTTP latency for the packument (info) and tarball endpoints. Dec 2022 onward.' },
  { method: 'npm-cli', title: 'npm CLI era (npm info / npm install jquery)', unit: 's', note: 'Full npm client operations — info resolves the packument, tarball runs an install. 2021 – mid 2022. Seconds, not directly comparable to the HTTP era.' },
];

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderHtml(), 'utf8');
console.log(path.relative(root, outputPath));

function renderHtml() {
  const sections = ERAS.map(renderEra).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verdaccio benchmark — history (2021–2023)</title>
<style>
  :root{color-scheme:light dark;--bg:#f7f8f4;--panel:#fff;--text:#1f2933;--muted:#5b6673;--line:#d7dcca;--accent:#0f766e;--head:#eef1e8;--grid:#e6eadc}
  @media(prefers-color-scheme:dark){:root{--bg:#14181c;--panel:#1c2127;--text:#e6e9ec;--muted:#9aa4af;--line:#2c333b;--accent:#4fd1c5;--head:#232a31;--grid:#2c333b}}
  body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
  main{width:min(1080px,calc(100% - 32px));margin:40px auto}
  h1{margin:0 0 4px;font-size:30px}h2{margin:40px 0 4px;font-size:22px}h3{margin:26px 0 6px;font-size:16px;color:var(--muted)}
  .meta,.desc{color:var(--muted);line-height:1.6}.desc{margin:0 0 14px}
  .callout{background:var(--head);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:16px 0;color:var(--muted);line-height:1.5}
  .tablewrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);margin-top:10px}
  th,td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
  th:first-child,td:first-child{text-align:left}th{font-size:12px;color:var(--muted);background:var(--head)}
  tr:last-child td{border-bottom:0}
  .swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:middle}
  .legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:10px 0;color:var(--muted);font-size:13px}
  svg{max-width:100%;height:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px}
  code{background:var(--head);padding:2px 5px;border-radius:4px}
</style></head><body><main>
  <h1>Verdaccio benchmark — history</h1>
  <div class="meta">Rescued from the 2021–2023 benchmark archive · ${data.records.toLocaleString('en-US')} records · ${data.versions.length} versions · ${data.dateRange.from.slice(0, 10)} → ${data.dateRange.to.slice(0, 10)}</div>
  <div class="callout"><strong>Read this first.</strong> The archive changed <em>what it measured</em> over time: early runs timed npm CLI operations (<code>npm info</code>/<code>npm install jquery</code>, seconds); later runs timed raw HTTP (<code>curl</code> to localhost, milliseconds). The two are shown separately below and must not be compared to each other, nor to today's runs (different machine, era, and package).</div>
  ${sections}
</main></body></html>
`;
}

function renderEra(era) {
  const rows = data.summary.filter((r) => r.method === era.method);
  if (rows.length === 0) return '';
  const endpoints = ['info', 'tarball'];
  const blocks = endpoints
    .map((endpoint) => {
      const er = rows.filter((r) => r.endpoint === endpoint);
      if (er.length === 0) return '';
      const records = data.data.filter((r) => r.method === era.method && r.endpoint === endpoint);
      return `<h3>${endpoint === 'info' ? 'Packument (info)' : 'Tarball'}</h3>
        ${summaryTable(er, era)}
        ${trendChart(records, era, endpoint)}`;
    })
    .join('\n');

  return `<h2>${escapeHtml(era.title)}</h2>
    <p class="desc">${escapeHtml(era.note)}</p>
    ${blocks}`;
}

function summaryTable(rows, era) {
  const toUnit = (ms) => (ms == null ? '-' : era.unit === 's' ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(2)}ms`);
  const showThroughput = era.method === 'http';
  const body = rows
    .map(
      (r) => `<tr>
      <td><span class="swatch" style="background:${versionColor.get(r.version)}"></span>${escapeHtml(r.version)}</td>
      <td>${r.runs}</td>
      <td>${toUnit(r.medianLatencyMs)}</td>
      ${showThroughput ? `<td>${r.medianReqPerSec == null ? '-' : Math.round(r.medianReqPerSec)}</td>` : ''}
      <td>${escapeHtml(r.from)} → ${escapeHtml(r.to)}</td>
    </tr>`
    )
    .join('');
  return `<div class="tablewrap"><table>
    <thead><tr><th>Version</th><th>Runs</th><th>Median ${era.unit === 's' ? 'duration' : 'latency'}</th>${showThroughput ? '<th>Req/s</th>' : ''}<th>Active range</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

// Inline SVG line chart: monthly-median latency over time, one line per version.
function trendChart(records, era, endpoint) {
  const months = monthRange(records);
  if (months.length < 2) return '';
  const byVersion = new Map();
  for (const r of records) {
    const v = r.version;
    if (!byVersion.has(v)) byVersion.set(v, new Map());
    const bucket = byVersion.get(v);
    const m = r.date.slice(0, 7);
    if (!bucket.has(m)) bucket.set(m, []);
    if (typeof r.latencyMs?.median === 'number') bucket.get(m).push(r.latencyMs.median);
  }

  const series = [];
  let maxY = 0;
  for (const [version, bucket] of byVersion) {
    const points = [];
    for (const m of months) {
      const vals = (bucket.get(m) ?? []).filter((x) => typeof x === 'number').sort((a, b) => a - b);
      if (vals.length) {
        const y = vals[Math.floor((vals.length - 1) / 2)];
        points.push({ m, y });
        if (y > maxY) maxY = y;
      }
    }
    if (points.length) series.push({ version, color: versionColor.get(version), points });
  }
  if (!maxY) return '';

  const W = 900, H = 280, ml = 56, mr = 12, mt = 12, mb = 40;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const x = (m) => ml + (months.indexOf(m) / (months.length - 1)) * plotW;
  const y = (v) => mt + plotH - (v / maxY) * plotH;
  const fmtY = (v) => (era.unit === 's' ? `${(v / 1000).toFixed(1)}s` : `${v.toFixed(1)}ms`);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
  const grid = yTicks
    .map((t) => `<line x1="${ml}" y1="${y(t).toFixed(1)}" x2="${W - mr}" y2="${y(t).toFixed(1)}" stroke="var(--grid)"/><text x="${ml - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtY(t)}</text>`)
    .join('');
  const xLabels = months
    .filter((_, i) => i % Math.ceil(months.length / 8) === 0)
    .map((m) => `<text x="${x(m).toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="11" fill="var(--muted)">${m}</text>`)
    .join('');
  const lines = series
    .map((s) => {
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.m).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
      const dots = s.points.map((p) => `<circle cx="${x(p.m).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="2.5" fill="${s.color}"/>`).join('');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>${dots}`;
    })
    .join('');
  const legend = series
    .map((s) => `<span><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.version)}</span>`)
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly median ${endpoint} ${era.unit === 's' ? 'duration' : 'latency'} by version">
    ${grid}
    <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" stroke="var(--line)"/>
    <line x1="${ml}" y1="${mt + plotH}" x2="${W - mr}" y2="${mt + plotH}" stroke="var(--line)"/>
    ${lines}${xLabels}
  </svg>
  <div class="legend">${legend}</div>`;
}

function monthRange(records) {
  const set = new Set(records.map((r) => r.date.slice(0, 7)));
  const sorted = [...set].sort();
  if (sorted.length < 2) return sorted;
  // Fill gaps so the x-axis is continuous.
  const out = [];
  let [y, m] = sorted[0].split('-').map(Number);
  const [ey, em] = sorted.at(-1).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
