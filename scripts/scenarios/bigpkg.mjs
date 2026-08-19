import { abBenchmark } from '../lib/ab.mjs';

// Serve LARGE packuments (typescript, next, @types/node, …) and measure raw HTTP
// throughput/latency of the full packument. These packages have thousands of
// versions, so @verdaccio/package-filter's filter_metadata — which iterates every
// version on each read (even as a no-op) — is most visible here. Combine with
// --package-filter to enable the filter and compare its cost across versions.
//
// OPT-IN (excluded from the default set): heavy, and it proxies real packages, so
// the target must be able to reach npmjs (default local/npmjs upstream both work).
// Storage is PRE-WARMED (each packument proxied + persisted once) so the measured
// runs are cache hits — we time Verdaccio serving from storage, not npmjs latency.
export const name = 'bigpkg';
export const unit = 'throughput';
export const optIn = true;

const DEFAULT_PACKAGES = ['typescript', 'next', '@types/node', 'react', 'aws-sdk', 'eslint'];

export async function run(h) {
  const server = await h.startTarget();
  const packages = h.bigpkgPackages ?? DEFAULT_PACKAGES;
  const results = [];

  try {
    for (const pkg of packages) {
      const url = `${server.registry}/${encodePackage(pkg)}`;
      // Isolated per package: a target that OOM-crashes on a huge packument (e.g.
      // `next` at high concurrency) shouldn't abort the whole run — record the
      // failure and continue.
      try {
        const primed = await primePackument(url, pkg); // proxy + persist once, capture size/versions
        const opts = { requests: h.serveRequests, concurrency: h.serveConcurrency };
        h.log(
          `  bigpkg ${pkg}: ${primed.versions ?? '?'} versions, ${(primed.bytes / 1e6).toFixed(1)}MB` +
            ` — ${h.serveRequests} req @ concurrency ${h.serveConcurrency}`
        );
        const served = await abBenchmark({ url, ...opts });
        results.push({ package: pkg, versions: primed.versions, bytes: primed.bytes, ...served });
        h.log(`    ${Math.round(served.requestsPerSecond ?? 0)} req/s, p95 ${served.latencyMs?.p95 ?? '-'}ms`);
      } catch (err) {
        results.push({ package: pkg, error: String(err.message ?? err) });
        h.log(`    ${pkg}: FAILED (${err.message ?? err}) — likely target OOM at this size/concurrency`);
      }
    }
    return { unit, samples: [], extra: { packages: results } };
  } finally {
    await server.stop();
  }
}

// Scoped packages are requested with an encoded slash (@scope%2fname).
function encodePackage(pkg) {
  return pkg.startsWith('@') ? pkg.replace('/', '%2f') : pkg;
}

async function primePackument(url, pkg) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Priming ${pkg} (${url}) failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let versions = null;
  try {
    versions = Object.keys(JSON.parse(buf.toString('utf8')).versions ?? {}).length;
  } catch {}
  return { bytes: buf.length, versions };
}
