import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { sourcesHtml } from './lib/report-common.mjs';

// Render a large-packument serving comparison from one benchmark run (the `bigpkg`
// scenario). One section per package (typescript, next, …); rows are versions/
// variants (e.g. `<v>` and `<v>+filter`) ordered by semver with the newest as
// baseline; columns are req/s (higher = better) and p95 latency. Meant to show how
// much @verdaccio/package-filter degrades serving of many-versioned packuments.
//
// Usage: node scripts/report-bigpkg.mjs --input results/bench-<ts>.json \
//          --title "package-filter cost" --output reports/bigpkg.html

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(root, 'results');
const args = parseArgs(process.argv.slice(2));

const inputPath = args.input ? path.resolve(args.input) : await latestBenchJson();
const data = JSON.parse(await readFile(inputPath, 'utf8'));
const title = typeof args.title === 'string' ? args.title : 'Verdaccio large-packument serving';
const outputPath = args.output ? path.resolve(args.output) : path.join(root, 'reports', 'bigpkg.html');

const rows = (data.rows ?? []).filter((r) => r.scenario === 'bigpkg');
if (!rows.length) throw new Error(`No bigpkg scenario in ${path.relative(root, inputPath)} (run --scenarios bigpkg first).`);
const concurrency = data.settings?.serveConcurrency ?? '?';
const pf = data.settings?.packageFilter;
const filterDesc =
  pf == null || pf === false
    ? 'none'
    : pf === true
      ? '{} (no-op — no rules, still iterates every version)'
      : pf.compare
        ? `off vs ${pf.rules === 'no-op' ? '{} (no-op)' : JSON.stringify(pf.rules)}`
        : JSON.stringify(pf);

const versions = [...new Set(rows.map((r) => r.version))].sort(cmpSemver);
const baseline = versions.at(-1);
// Package list (union, in first-seen order) + a versions/bytes lookup from the data.
const packages = [];
for (const r of rows) for (const p of r.extra?.packages ?? []) if (!packages.includes(p.package)) packages.push(p.package);
const cell = (version, pkg) => rows.find((r) => r.version === version)?.extra?.packages?.find((p) => p.package === pkg);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderHtml(), 'utf8');
console.log(path.relative(root, outputPath));

async function latestBenchJson() {
  const files = (await readdir(resultsDir)).filter((f) => f.startsWith('bench-') && f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`No bench-*.json in ${resultsDir}`);
  return path.join(resultsDir, files.at(-1));
}

function renderHtml() {
  const up = data.upstream ?? {};
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
  code{background:var(--head);padding:2px 5px;border-radius:4px}
</style></head><body><main>
  <h1>${escapeHtml(title)}</h1>
  <div class="sub">${versions.length} variants · baseline <code>${escapeHtml(baseline)}</code> (newest) · upstream: ${escapeHtml(up.mode ?? 'unknown')} · concurrency ${escapeHtml(String(concurrency))}<br>
    Source run ${escapeHtml((data.env?.capturedAt ?? data.runId ?? '').slice(0, 16).replace('T', ' '))} on ${escapeHtml(data.env?.cpu?.model ?? 'unknown CPU')}</div>
  <p class="desc"><strong>Filter:</strong> <code>@verdaccio/package-filter</code> — config: <code>${escapeHtml(filterDesc)}</code>. Variants labeled <code>+filter</code> have it enabled; the others configure no filters at all.</p>
  <p class="desc">Warm packument serving (storage cache hits). Higher req/s is better; Δ is req/s vs the baseline variant. Large version counts / big packuments are where the filter — and packument size itself — would show.</p>
  ${packages.map(renderPackage).join('\n')}
  ${sourcesHtml(data)}
</main></body></html>
`;
}

function renderPackage(pkg) {
  const meta = versions.map((v) => cell(v, pkg)).find(Boolean);
  const rowsHtml = versions
    .map((v) => {
      const c = cell(v, pkg);
      const baseRps = cell(baseline, pkg)?.requestsPerSecond;
      const d = delta(c?.requestsPerSecond, baseRps);
      return `<tr class="${v === baseline ? 'base' : ''}">
        <td>${escapeHtml(v)}${v === baseline ? ' (base)' : ''}</td>
        <td>${c?.error ? '<span class="bad">FAILED</span>' : c?.versions ?? '-'}</td>
        <td>${c?.bytes == null ? '-' : (c.bytes / 1e6).toFixed(1)}</td>
        <td>${c?.requestsPerSecond == null ? '-' : c.requestsPerSecond.toFixed(1)}</td>
        <td class="${d.cls}">${d.text}</td>
        <td>${c?.latencyMs?.p95 == null ? '-' : Math.round(c.latencyMs.p95) + 'ms'}</td>
        <td>${c?.timePerRequestMeanMs == null ? '-' : Math.round(c.timePerRequestMeanMs) + 'ms'}</td>
      </tr>`;
    })
    .join('');
  return `<h2>${escapeHtml(pkg)} <span class="desc">· ${meta?.versions ?? '?'} versions · ${meta ? (meta.bytes / 1e6).toFixed(1) : '?'} MB (unfiltered)</span></h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Variant</th><th>Versions</th><th>MB</th><th>Req/s</th><th>Δ vs ${escapeHtml(baseline)}</th><th>p95</th><th>mean</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>`;
}

function delta(value, base) {
  if (value == null || base == null || base === 0) return { text: '–', cls: '' };
  const pct = ((value - base) / base) * 100;
  if (Math.abs(pct) < 0.05) return { text: '0%', cls: '' };
  return { text: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`, cls: pct > 0 ? 'good' : 'bad' };
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

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
