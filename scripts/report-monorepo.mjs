import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { sourcesHtml } from './lib/report-common.mjs';

// Render a monorepo-publish comparison page from a single benchmark run, in the
// same style as report-compare: versions ordered by semver, newest as baseline,
// % deltas. Shows the lerna release time + throughput, and — when the run used
// --monorepo-per-package — the per-package publish latency distribution.
//
// Usage: node scripts/report-monorepo.mjs --input results/bench-<ts>.json \
//          --title "Verdaccio monorepo publish" --output reports/monorepo.html

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(root, 'results');
const args = parseArgs(process.argv.slice(2));

const inputPath = args.input ? path.resolve(args.input) : await latestBenchJson();
const data = JSON.parse(await readFile(inputPath, 'utf8'));
const title = typeof args.title === 'string' ? args.title : 'Verdaccio monorepo publish';
const outputPath = args.output ? path.resolve(args.output) : path.join(root, 'reports', 'monorepo.html');

// Pull the monorepo rows: summary carries the release-time median/p95, rows carry
// the extra payload (packages, throughput, per-package distribution).
const summaryRows = (data.summary ?? []).filter((r) => r.scenario === 'monorepo' && r.unit === 'ms');
const extraRows = (data.rows ?? []).filter((r) => r.scenario === 'monorepo');
if (!summaryRows.length) {
  throw new Error(`No monorepo scenario in ${path.relative(root, inputPath)} (run --scenarios monorepo first).`);
}

const versions = [...new Set(summaryRows.map((r) => r.version))].sort(cmpSemver);
const baseline = versions.at(-1);
const byVersion = (v) => ({
  summary: summaryRows.find((r) => r.version === v),
  extra: extraRows.find((r) => r.version === v)?.extra ?? {},
});
const hasPerPackage = extraRows.some((r) => r.extra?.perPackage);
const packages = extraRows.find((r) => r.extra?.packages)?.extra?.packages ?? '?';
// legacyAuthCache off/on compare: any `<version>+cache` variant present. The harness
// injects the SAME server.legacyAuthCache block for every +cache target (createConfig
// in lib/verdaccio.mjs); compare mode uses the defaults unless --legacy-auth-cache-ttl
// was passed (which the run records as a number in settings.legacyAuthCache).
const cacheVariants = versions.filter((v) => v.endsWith('+cache'));
const hasCache = cacheVariants.length > 0;
const lacSetting = data.settings?.legacyAuthCache;
const cacheTtlMs = typeof lacSetting === 'number' ? lacSetting : 30000;
const cacheMaxEntries = 1000;

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
  const provenance =
    up.mode === 'frozen'
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
  pre{background:var(--head);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow-x:auto;font-size:12.5px;line-height:1.45;margin:0}
  .cfgcols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px}
  .cfgcols h3{margin:0 0 6px;font-size:13px;color:var(--muted);font-weight:600}
  @media(max-width:640px){.cfgcols{grid-template-columns:1fr}}
</style></head><body><main>
  <h1>${escapeHtml(title)}</h1>
  <div class="sub">${versions.length} versions · <code>${escapeHtml(String(packages))}</code> packages per release · baseline <code>${escapeHtml(baseline)}</code> (newest) · ${provenance}<br>
    Source run ${escapeHtml((data.env?.capturedAt ?? data.runId ?? '').slice(0, 16).replace('T', ' '))} · ${data.samples} samples on ${escapeHtml(data.env?.cpu?.model ?? 'unknown CPU')}</div>
  <p class="desc">Δ is versus the baseline; lower is better (green = faster). "Release" is the total <code>lerna publish</code> wall-clock; throughput is packages/second.</p>
  ${renderRelease()}
  ${hasCache ? renderConfig() : ''}
  ${hasPerPackage ? renderPerPackage() : ''}
  ${sourcesHtml(data)}
</main></body></html>
`;
}

function renderRelease() {
  const rows = versions.map((v) => {
    const { summary, extra } = byVersion(v);
    return { version: v, median: summary?.medianMs ?? null, p95: summary?.p95Ms ?? null, tput: extra.throughputPerSec ?? null };
  });
  const baseVal = rows.find((r) => r.version === baseline)?.median;
  const max = Math.max(...rows.map((r) => r.median ?? 0)) || 1;

  const body = rows
    .map((r) => {
      const d = delta(r.median, baseVal, 'lower');
      return `<tr class="${r.version === baseline ? 'base' : ''}">
        <td>${escapeHtml(r.version)}${r.version === baseline ? ' (base)' : ''}</td>
        <td>${fmtMs(r.median)}</td>
        <td>${fmtMs(r.p95)}</td>
        <td class="${d.cls}">${d.text}</td>
        <td>${r.tput == null ? '-' : r.tput.toFixed(1)}</td>
      </tr>`;
    })
    .join('');
  const bars = rows
    .map((r) => `<div class="bar-row"><div>${escapeHtml(r.version)}</div>
      <div class="track"><div class="fill ${r.version === baseline ? 'base' : ''}" style="width:${Math.round(((r.median ?? 0) / max) * 100)}%"></div></div>
      <div>${fmtMs(r.median)}</div></div>`)
    .join('');

  return `<h2>Release (lerna publish, ${escapeHtml(String(packages))} packages)</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Version</th><th>Median</th><th>p95</th><th>Δ vs ${escapeHtml(baseline)}</th><th>pkg/s</th></tr></thead>
      <tbody>${body}</tbody></table></div>
    <div class="bars">${bars}</div>`;
}

function renderConfig() {
  const off = `auth:
  htpasswd:
    file: &lt;storage&gt;/htpasswd
    max_users: 1000
# no server.legacyAuthCache block →
# bcrypt runs on every authenticated request`;
  const on = `server:
  legacyAuthCache:
    enabled: true
    ttlMs: ${cacheTtlMs}
    maxEntries: ${cacheMaxEntries}
auth:
  htpasswd:
    file: &lt;storage&gt;/htpasswd
    max_users: 1000`;

  // Per base image: was the cache actually honored? Infer from the measured effect —
  // if the +cache run is ≥30% faster than its no-cache run, the target respected the
  // block; otherwise it ignored it (unsupported version) or auth wasn't the bottleneck.
  const bases = versions.filter((v) => !v.endsWith('+cache'));
  const rows = bases
    .map((v) => {
      const offMs = byVersion(v).summary?.medianMs;
      const onMs = byVersion(`${v}+cache`).summary?.medianMs;
      if (offMs == null || onMs == null) return null;
      const honored = offMs > 0 && (offMs - onMs) / offMs >= 0.3;
      const pct = offMs > 0 ? Math.round(((onMs - offMs) / offMs) * 100) : 0;
      const effect = honored
        ? `<span class="good">honored</span> · ${fmtMs(offMs)} → ${fmtMs(onMs)} <span class="good">(${pct}%)</span>`
        : `<span class="muted">no effect</span> · ${fmtMs(offMs)} → ${fmtMs(onMs)} <span class="muted">(${pct > 0 ? '+' : ''}${pct}%)</span>`;
      return `<tr><td>${escapeHtml(v)}</td>
        <td><code>server.legacyAuthCache</code> absent</td>
        <td><code>enabled: true, ttlMs: ${cacheTtlMs}, maxEntries: ${cacheMaxEntries}</code></td>
        <td>${effect}</td></tr>`;
    })
    .filter(Boolean)
    .join('');

  return `<h2>Auth cache configuration</h2>
    <p class="desc">Every version is measured twice. The harness injects the <em>same</em> config into the
      target for each pair (<code>createConfig</code> in <code>scripts/lib/verdaccio.mjs</code>);
      the only difference is the <code>server.legacyAuthCache</code> block. That cache memoizes successful
      legacy Bearer-token validations so <strong>bcrypt does not re-run on every authenticated request</strong>
      — it is a Verdaccio 7.x / 9.x feature (and 6.10+). Versions that don't support it (e.g. 5.x, which
      uses <code>crypt</code>) receive the block but ignore it, so their <code>+cache</code> run shows no effect.
      Compare mode uses the harness defaults (<code>ttlMs: ${cacheTtlMs}</code>, <code>maxEntries: ${cacheMaxEntries}</code>);
      override with <code>--legacy-auth-cache-ttl</code>.</p>
    <div class="cfgcols">
      <div><h3>Without cache (base variant)</h3><pre>${off}</pre></div>
      <div><h3>With cache (<code>+cache</code> variant)</h3><pre>${on}</pre></div>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Image</th><th>No-cache run</th><th><code>+cache</code> run</th><th>Effect (measured)</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function renderPerPackage() {
  const rows = versions.map((v) => ({ version: v, pp: byVersion(v).extra.perPackage ?? null }));
  const baseVal = rows.find((r) => r.version === baseline)?.pp?.medianMs;
  const body = rows
    .map((r) => {
      const pp = r.pp;
      const d = delta(pp?.medianMs, baseVal, 'lower');
      return `<tr class="${r.version === baseline ? 'base' : ''}">
        <td>${escapeHtml(r.version)}${r.version === baseline ? ' (base)' : ''}</td>
        <td>${fmtMs(pp?.medianMs)}</td>
        <td>${fmtMs(pp?.p95Ms)}</td>
        <td>${fmtMs(pp?.minMs)}</td>
        <td>${fmtMs(pp?.maxMs)}</td>
        <td class="${d.cls}">${d.text}</td>
      </tr>`;
    })
    .join('');
  return `<h2>Per-package publish (<code>npm publish</code>, serial)</h2>
    <p class="desc">Latency of a single package publish, measured one-by-one — this is where per-request auth cost (bcrypt) shows up.</p>
    <div class="tablewrap"><table>
      <thead><tr><th>Version</th><th>Median</th><th>p95</th><th>Min</th><th>Max</th><th>Δ median vs ${escapeHtml(baseline)}</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
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
