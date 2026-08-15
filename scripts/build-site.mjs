import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuns } from './lib/runs.mjs';

// Assemble the GitHub Pages site:
//  - index.html: a dashboard (runs-by-date list + progress-over-time charts)
//  - every reports/*.html copied in (per-run reports + the 2021-2023 archive)
// The benchmark is never run here; CI only publishes committed data.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(root, 'reports');
const runsPath = path.join(root, 'results', 'history', 'runs.json');
const archivePath = path.join(root, 'results', 'history', 'history.json');
const siteDir = path.join(root, '_site');

const SCENARIOS = [
  { key: 'warm-install', label: 'warm-install', unit: 'ms', metric: 'medianMs' },
  { key: 'proxy-install', label: 'proxy-install', unit: 'ms', metric: 'medianMs' },
  { key: 'publish', label: 'publish', unit: 'ms', metric: 'medianMs' },
  { key: 'unpublish', label: 'unpublish', unit: 'ms', metric: 'medianMs' },
  { key: 'serve', label: 'serve — tarball p50 latency', unit: 'ms', metric: 'serveTarballP50Ms', archive: true },
];

// Stable color per Verdaccio major.
const MAJOR_COLOR = { 3: '#c2410c', 4: '#a16207', 5: '#0369a1', 6: '#0f766e', 7: '#7c3aed', 9: '#be123c' };

const runs = await readRuns(runsPath);
const archive = await readFile(archivePath, 'utf8').then((r) => JSON.parse(r)).catch(() => null);

await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });

const htmlFiles = (await readdir(reportsDir).catch(() => [])).filter((f) => f.endsWith('.html'));
for (const file of htmlFiles) await copyFile(path.join(reportsDir, file), path.join(siteDir, file));

await writeFile(path.join(siteDir, 'index.html'), renderDashboard(), 'utf8');
await writeFile(path.join(siteDir, 'all.html'), renderAll(htmlFiles), 'utf8');

console.log(`Built _site/ — ${runs.length} run(s), ${htmlFiles.length} report page(s).`);

// --- dashboard -------------------------------------------------------------

function renderDashboard() {
  const latest = runs.at(-1);
  const charts = SCENARIOS.map(renderScenarioChart).filter(Boolean).join('\n');
  const hasArchive = archive && SCENARIOS.some((s) => s.archive);

  return page(
    'Verdaccio benchmark',
    `<h1>Verdaccio benchmark</h1>
    <p class="sub">${runs.length} run${runs.length === 1 ? '' : 's'} recorded${latest ? ` · latest ${escapeHtml(latest.date.slice(0, 16).replace('T', ' '))} on ${escapeHtml(latest.env.cpu ?? 'unknown CPU')}` : ''}</p>

    <h2>Runs by date</h2>
    ${runsTable()}

    <h2>Progress over time</h2>
    <p class="desc">Median per Verdaccio major across runs. Lower is better.${hasArchive ? ' The serve chart is seeded with the 2021–2023 archive (hollow points, dashed) — a <strong>different machine</strong>, so treat the archive→now step as directional, not exact.' : ''}</p>
    ${charts}

    <p class="foot"><a href="./archive.html">Deep 2021–2023 archive →</a> · <a href="./all.html">All report pages →</a></p>`
  );
}

function runsTable() {
  if (runs.length === 0) return '<p class="desc">No runs recorded yet. Run <code>pnpm bench</code> then <code>pnpm report</code>.</p>';
  const rows = [...runs]
    .reverse()
    .map((r) => {
      const versions = Object.entries(r.versions).map(([l, v]) => `${escapeHtml(l)}=${escapeHtml(v)}`).join(', ');
      return `<tr>
        <td><a href="./${escapeHtml(r.report)}">${escapeHtml(r.date.slice(0, 16).replace('T', ' '))}</a></td>
        <td>${versions}</td>
        <td>${r.scenarios.map(escapeHtml).join(', ')}</td>
        <td>${escapeHtml(r.env.cpu ?? '-')}</td>
      </tr>`;
    })
    .join('');
  return `<div class="tablewrap"><table>
    <thead><tr><th>Date (report)</th><th>Versions</th><th>Scenarios</th><th>Machine</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderScenarioChart(scenario) {
  // series keyed by major: [{ t, y, kind }]
  const byMajor = new Map();
  const add = (major, t, y, kind) => {
    if (major == null || !Number.isFinite(y) || !Number.isFinite(t)) return;
    if (!byMajor.has(major)) byMajor.set(major, []);
    byMajor.get(major).push({ t, y, kind });
  };

  for (const run of runs) {
    const t = Date.parse(run.date);
    for (const m of run.metrics) {
      if (m.scenario !== scenario.key) continue;
      add(majorOf(m.version), t, m[scenario.metric], 'new');
    }
  }

  if (scenario.archive && archive) {
    // One aggregated archive point per major: median HTTP-era tarball p50 at the
    // major's median date.
    const g = new Map();
    for (const rec of archive.data) {
      if (rec.method !== 'http' || rec.endpoint !== 'tarball') continue;
      const major = rec.major;
      const y = rec.server?.latencyAvgMs ?? rec.latencyMs?.median;
      if (!Number.isFinite(y)) continue;
      if (!g.has(major)) g.set(major, { ys: [], ts: [] });
      g.get(major).ys.push(y);
      g.get(major).ts.push(rec.ts);
    }
    for (const [major, { ys, ts }] of g) add(major, median(ts), median(ys), 'archive');
  }

  if (byMajor.size === 0) return '';
  return timeSeriesChart(scenario, byMajor);
}

// Inline SVG time-series: x = real dates, one line per major.
function timeSeriesChart(scenario, byMajor) {
  const all = [...byMajor.values()].flat();
  const tMin = Math.min(...all.map((p) => p.t));
  const tMax = Math.max(...all.map((p) => p.t));
  const yMax = Math.max(...all.map((p) => p.y)) * 1.1 || 1;
  const hasArchive = all.some((p) => p.kind === 'archive');

  const W = 900, H = 260, ml = 60, mr = 90, mt = 14, mb = 34;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const x = (t) => (tMax === tMin ? ml + plotW / 2 : ml + ((t - tMin) / (tMax - tMin)) * plotW);
  const y = (v) => mt + plotH - (v / yMax) * plotH;
  const fmtY = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

  const yTicks = [0, 0.5, 1].map((f) => f * yMax);
  const grid = yTicks
    .map((t) => `<line x1="${ml}" y1="${y(t).toFixed(1)}" x2="${W - mr}" y2="${y(t).toFixed(1)}" stroke="var(--grid)"/><text x="${ml - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtY(t)}</text>`)
    .join('');
  const xTicks = tMax === tMin ? [tMin] : [tMin, (tMin + tMax) / 2, tMax];
  const xLabels = xTicks
    .map((t) => `<text x="${x(t).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="var(--muted)">${new Date(t).toISOString().slice(0, 10)}</text>`)
    .join('');

  const series = [...byMajor.entries()].sort((a, b) => a[0] - b[0]);
  const lines = series
    .map(([major, pts]) => {
      const color = MAJOR_COLOR[major] ?? '#5b6673';
      const sorted = [...pts].sort((a, b) => a.t - b.t);
      const d = sorted.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
      const dash = sorted.some((p) => p.kind === 'archive') ? ' stroke-dasharray="5 4"' : '';
      const path = sorted.length > 1 ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"${dash}/>` : '';
      const dots = sorted
        .map((p) =>
          p.kind === 'archive'
            ? `<rect x="${(x(p.t) - 3.5).toFixed(1)}" y="${(y(p.y) - 3.5).toFixed(1)}" width="7" height="7" transform="rotate(45 ${x(p.t).toFixed(1)} ${y(p.y).toFixed(1)})" fill="none" stroke="${color}" stroke-width="1.5"/>`
            : `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="3" fill="${color}"/>`
        )
        .join('');
      return path + dots;
    })
    .join('');
  const legend = series
    .map(([major]) => `<span><span class="swatch" style="background:${MAJOR_COLOR[major] ?? '#5b6673'}"></span>v${major}</span>`)
    .join('');

  return `<h3>${escapeHtml(scenario.label)}</h3>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(scenario.label)} over time by major version">
    ${grid}
    <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" stroke="var(--line)"/>
    <line x1="${ml}" y1="${mt + plotH}" x2="${W - mr}" y2="${mt + plotH}" stroke="var(--line)"/>
    ${lines}${xLabels}
  </svg>
  <div class="legend">${legend}${hasArchive ? '<span class="muted">◇ archive (other machine)&nbsp;&nbsp;● new run</span>' : ''}</div>`;
}

function renderAll(files) {
  const list = files
    .sort()
    .reverse()
    .map((f) => `<li><a href="./${escapeHtml(f)}">${escapeHtml(f)}</a></li>`)
    .join('');
  return page('All report pages', `<h1>All report pages</h1><p><a href="./index.html">← Dashboard</a></p><ul>${list || '<li>None yet.</li>'}</ul>`);
}

// --- helpers ---------------------------------------------------------------

function majorOf(version) {
  const m = String(version ?? '').match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

function median(values) {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return clean.length ? clean[Math.floor((clean.length - 1) / 2)] : NaN;
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark;--bg:#f7f8f4;--panel:#fff;--text:#1f2933;--muted:#5b6673;--line:#d7dcca;--accent:#0f766e;--head:#eef1e8;--grid:#e6eadc}
  @media(prefers-color-scheme:dark){:root{--bg:#14181c;--panel:#1c2127;--text:#e6e9ec;--muted:#9aa4af;--line:#2c333b;--accent:#4fd1c5;--head:#232a31;--grid:#2c333b}}
  body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
  main{width:min(1000px,calc(100% - 32px));margin:40px auto}
  h1{margin:0 0 4px;font-size:30px}h2{margin:36px 0 8px;font-size:21px}h3{margin:22px 0 6px;font-size:15px;color:var(--muted)}
  .sub{color:var(--muted);margin:0 0 8px}.desc{color:var(--muted);line-height:1.5;margin:0 0 12px}.foot{margin-top:36px;color:var(--muted)}
  a{color:var(--accent)}
  .tablewrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line)}
  th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;font-size:14px}
  th{font-size:12px;color:var(--muted);background:var(--head)}tr:last-child td{border-bottom:0}
  svg{max-width:100%;height:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px}
  .swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:middle}
  .legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:8px 0 4px;color:var(--muted);font-size:13px}.legend .muted{opacity:.8}
  code{background:var(--head);padding:2px 5px;border-radius:4px}ul{line-height:1.8}
</style></head><body><main>${body}</main></body></html>
`;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
