import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';

// Render a version-comparison page from a single benchmark run: same metrics as
// the per-run report, but framed as a head-to-head across versions ordered by
// semver, with the newest as the baseline and % deltas against it. Numbers are
// baked into the HTML, so committing the page pins the comparison ("official run").
//
// Usage: node scripts/report-compare.mjs --input results/bench-<ts>.json \
//          --title "Verdaccio v6 line" --output reports/compare-v6.html

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(root, 'results');
const args = parseArgs(process.argv.slice(2));

const inputPath = args.input ? path.resolve(args.input) : await latestBenchJson();
const data = JSON.parse(await readFile(inputPath, 'utf8'));
const title = typeof args.title === 'string' ? args.title : 'Verdaccio version comparison';
const outputPath = args.output ? path.resolve(args.output) : path.join(root, 'reports', 'compare.html');

const MS_SCENARIOS = ['warm-install', 'proxy-install', 'publish', 'unpublish', 'search'];

// Versions present, ordered oldest → newest by semver; newest is the baseline.
const versions = [...new Set(data.summary.map((r) => r.version))].sort(cmpSemver);
const baseline = versions.at(-1);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderHtml(), 'utf8');
console.log(path.relative(root, outputPath));

async function latestBenchJson() {
  const files = (await readdir(resultsDir)).filter((f) => f.startsWith('bench-') && f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`No bench-*.json in ${resultsDir}`);
  return path.join(resultsDir, files.at(-1));
}

function renderHtml() {
  const msSections = MS_SCENARIOS.filter((s) => data.summary.some((r) => r.scenario === s && r.unit === 'ms'))
    .map(renderMsScenario)
    .join('\n');
  const serveSection = renderServe();
  const up = data.upstream ?? {};
  const provenance = up.mode === 'frozen'
    ? `frozen snapshot ${up.snapshot?.sha256?.slice(0, 12) ?? '?'}… (${up.snapshotCreatedAt?.slice(0, 10) ?? '?'})`
    : `upstream: ${escapeHtml(up.mode ?? 'unknown')}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noai, noimageai">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark;--bg:#f7f8f4;--panel:#fff;--text:#1f2933;--muted:#5b6673;--line:#d7dcca;--accent:#0f766e;--bar:#7c3aed;--barbase:#0f766e;--head:#eef1e8;--good:#15803d;--bad:#b91c1c}
  @media(prefers-color-scheme:dark){:root{--bg:#14181c;--panel:#1c2127;--text:#e6e9ec;--muted:#9aa4af;--line:#2c333b;--accent:#4fd1c5;--bar:#a78bfa;--barbase:#4fd1c5;--head:#232a31;--good:#4ade80;--bad:#f87171}}
  body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
  main{width:min(1000px,calc(100% - 32px));margin:40px auto}
  h1{margin:0 0 4px;font-size:30px}h2{margin:34px 0 8px;font-size:20px}
  .sub{color:var(--muted);margin:0 0 6px;line-height:1.5}.desc{color:var(--muted);margin:0 0 10px}
  .tablewrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);margin-top:6px}
  th,td{padding:8px 12px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap;font-size:14px}
  th:first-child,td:first-child{text-align:left}th{font-size:12px;color:var(--muted);background:var(--head)}
  tr:last-child td{border-bottom:0}
  .base{font-weight:700}.good{color:var(--good)}.bad{color:var(--bad)}
  .bars{display:grid;gap:6px;margin-top:10px}
  .bar-row{display:grid;grid-template-columns:70px 1fr 132px;gap:10px;align-items:center;font-size:13px}
  .track{height:13px;background:var(--head);border:1px solid var(--line);border-radius:3px;overflow:hidden}
  .fill{height:100%;background:var(--bar)}.fill.base{background:var(--barbase)}
  code{background:var(--head);padding:2px 5px;border-radius:4px}
</style></head><body><main>
  <h1>${escapeHtml(title)}</h1>
  <div class="sub">${versions.length} versions · baseline <code>${escapeHtml(baseline)}</code> (newest) · ${provenance}<br>
    Source run ${escapeHtml((data.env?.capturedAt ?? data.runId ?? '').slice(0, 16).replace('T', ' '))} · ${data.samples} samples on ${escapeHtml(data.env?.cpu?.model ?? 'unknown CPU')}</div>
  <p class="desc">Δ is versus the baseline. For durations, lower is better (green Δ = faster than baseline). For serve req/s, higher is better.</p>
  ${msSections}
  ${serveSection}
</main></body></html>
`;
}

function renderMsScenario(scenario) {
  const rows = versions.map((v) => {
    const r = data.summary.find((x) => x.scenario === scenario && x.version === v);
    return { version: v, value: r?.medianMs ?? null };
  });
  const baseVal = rows.find((r) => r.version === baseline)?.value;
  const max = Math.max(...rows.map((r) => r.value ?? 0)) || 1;

  const body = rows
    .map((r) => {
      const d = delta(r.value, baseVal, 'lower');
      return `<tr class="${r.version === baseline ? 'base' : ''}">
        <td>${escapeHtml(r.version)}${r.version === baseline ? ' (base)' : ''}</td>
        <td>${fmtMs(r.value)}</td>
        <td class="${d.cls}">${d.text}</td>
      </tr>`;
    })
    .join('');
  const bars = rows
    .map((r) => `<div class="bar-row"><div>${escapeHtml(r.version)}</div>
      <div class="track"><div class="fill ${r.version === baseline ? 'base' : ''}" style="width:${Math.round(((r.value ?? 0) / max) * 100)}%"></div></div>
      <div>${fmtMs(r.value)}</div></div>`)
    .join('');

  return `<h2>${escapeHtml(scenario)}</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Version</th><th>Median</th><th>Δ vs ${escapeHtml(baseline)}</th></tr></thead>
      <tbody>${body}</tbody></table></div>
    <div class="bars">${bars}</div>`;
}

function renderServe() {
  const serveRows = data.rows?.filter((r) => r.scenario === 'serve') ?? [];
  if (!serveRows.length) return '';
  const endpoints = [...new Set(serveRows.flatMap((r) => (r.extra?.endpoints ?? []).map((e) => e.endpoint)))];

  const sections = endpoints
    .map((endpoint) => {
      const rows = versions.map((v) => {
        const raw = serveRows.find((r) => r.version === v);
        const e = raw?.extra?.endpoints?.find((x) => x.endpoint === endpoint);
        return { version: v, rps: e?.requestsPerSecond ?? null, p95: e?.latencyMs?.p95 ?? null };
      });
      const baseRps = rows.find((r) => r.version === baseline)?.rps;
      const body = rows
        .map((r) => {
          const d = delta(r.rps, baseRps, 'higher');
          return `<tr class="${r.version === baseline ? 'base' : ''}">
            <td>${escapeHtml(r.version)}${r.version === baseline ? ' (base)' : ''}</td>
            <td>${r.rps == null ? '-' : Math.round(r.rps)}</td>
            <td class="${d.cls}">${d.text}</td>
            <td>${r.p95 == null ? '-' : Math.round(r.p95) + 'ms'}</td>
          </tr>`;
        })
        .join('');
      return `<h2>serve · ${escapeHtml(endpoint)}</h2>
        <div class="tablewrap"><table>
          <thead><tr><th>Version</th><th>Req/s</th><th>Δ vs ${escapeHtml(baseline)}</th><th>p95 latency</th></tr></thead>
          <tbody>${body}</tbody></table></div>`;
    })
    .join('\n');
  return sections;
}

function delta(value, base, betterWhen) {
  if (value == null || base == null || base === 0) return { text: '–', cls: '' };
  const pct = ((value - base) / base) * 100;
  if (Math.abs(pct) < 0.05) return { text: '0%', cls: '' };
  const faster = betterWhen === 'lower' ? pct < 0 : pct > 0;
  return { text: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`, cls: faster ? 'good' : 'bad' };
}

function cmpSemver(a, b) {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function fmtMs(v) {
  return v == null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
