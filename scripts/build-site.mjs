import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Assemble the GitHub Pages site from the committed HTML reports:
//  - every reports/*.html is copied into _site/ (so old runs stay linkable)
//  - the newest bench-*.html becomes index.html (the "latest report")
//  - all.html lists every report, newest first
// The benchmark itself is NOT run here — timings must come from a controlled
// machine, not a shared CI runner. CI only publishes what was committed.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(root, 'reports');
const siteDir = path.join(root, '_site');

await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });

const htmlFiles = (await readdir(reportsDir).catch(() => []))
  .filter((f) => f.endsWith('.html'))
  .sort()
  .reverse(); // timestamped names sort chronologically; newest first

for (const file of htmlFiles) {
  await copyFile(path.join(reportsDir, file), path.join(siteDir, file));
}

// Prefer a bench-*.html as the landing page; fall back to any report.
const latest = htmlFiles.find((f) => f.startsWith('bench-')) ?? htmlFiles[0];

if (latest) {
  await copyFile(path.join(reportsDir, latest), path.join(siteDir, 'index.html'));
} else {
  await writeFile(path.join(siteDir, 'index.html'), placeholder(), 'utf8');
}

await writeFile(path.join(siteDir, 'all.html'), indexPage(htmlFiles, latest), 'utf8');

console.log(`Built _site/ from ${htmlFiles.length} report(s).`);
console.log(latest ? `index.html -> ${latest}` : 'index.html -> placeholder (no reports found)');

function indexPage(files, latest) {
  const items = files
    .map((f) => `<li><a href="./${escapeHtml(f)}">${escapeHtml(f)}</a>${f === latest ? ' <em>(latest)</em>' : ''}</li>`)
    .join('\n');
  return page('All reports', `<h1>Verdaccio benchmark reports</h1>
    <p><a href="./index.html">Latest report →</a></p>
    <ul>${items || '<li>No reports yet.</li>'}</ul>`);
}

function placeholder() {
  return page(
    'Verdaccio benchmark',
    `<h1>Verdaccio benchmark</h1>
     <p>No report has been published yet. Run <code>pnpm bench</code> then <code>pnpm report</code>, commit the generated <code>reports/bench-*.html</code>, and push.</p>`
  );
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;line-height:1.6}a{color:#0f766e}li{margin:4px 0}</style>
</head><body>${body}</body></html>
`;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
