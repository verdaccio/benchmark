// Shared report helper: a "Sources" legend so every report states plainly what
// each measured version actually was — a published npm package, a local tarball,
// or a Docker image (recorded by digest + build date, since tags are mutable).

function esc(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function sourcesHtml(data) {
  const src = data?.sources;
  if (!src || !Object.keys(src).length) return '';
  const rows = Object.entries(src)
    .map(([version, s]) => `<tr><td>${esc(version)}</td><td>${describe(s)}</td></tr>`)
    .join('');
  return `<h2>Sources</h2>
    <p class="desc">What each variant actually is. Docker images use mutable tags, so the digest + build date pin the exact build measured. (<code>+cache</code>/<code>+filter</code> variants are config toggles on the same source.)</p>
    <div class="tablewrap"><table>
      <thead><tr><th>Variant</th><th>Source</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function describe(s) {
  if (s.kind === 'docker') {
    const sha = s.digest?.includes('@') ? s.digest.split('@')[1] : s.digest;
    return (
      `Docker image <code>${esc(s.ref)}</code>` +
      (sha ? ` · <span class="muted">${esc(sha.slice(0, 19))}…</span>` : '') +
      (s.built ? ` · built ${esc(s.built)}` : '')
    );
  }
  if (s.kind === 'tarball') return `Local tarball <code>${esc(s.ref.split('/').pop())}</code>`;
  return `npm package <code>${esc(s.ref)}</code>`;
}
