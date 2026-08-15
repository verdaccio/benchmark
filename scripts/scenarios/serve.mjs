import { abBenchmark } from '../lib/ab.mjs';

// Server-isolation benchmark: hit Verdaccio's HTTP endpoints directly with ab,
// bypassing npm's resolution/extraction. This is where raw serving differences
// between versions surface, unmasked by client-side install cost. Storage is
// pre-warmed for the target package so we measure cache-hit serving.
export const name = 'serve';
export const unit = 'throughput';

// npm asks for the abbreviated packument by default; benchmark that path too.
const ABBREVIATED = 'Accept: application/vnd.npm.install-v1+json';
const PKG = 'lodash';

export async function run(h) {
  const server = await h.startTarget();
  const version = h.fixture.dependencies?.[PKG];
  if (!version) throw new Error(`serve scenario expects "${PKG}" in the fixture dependencies`);

  const packumentUrl = `${server.registry}/${PKG}`;
  const tarballUrl = `${server.registry}/${PKG}/-/${PKG}-${version}.tgz`;

  try {
    // Prime target storage: one fetch each makes Verdaccio proxy + persist them,
    // so the measured runs are cache hits.
    await primeUrl(packumentUrl);
    await primeUrl(packumentUrl, ABBREVIATED);
    await primeUrl(tarballUrl);

    const opts = { requests: h.serveRequests, concurrency: h.serveConcurrency };
    const endpoints = [];

    h.log(`  serve: ${h.serveRequests} req @ concurrency ${h.serveConcurrency}`);
    endpoints.push({ endpoint: 'packument', ...(await abBenchmark({ url: packumentUrl, ...opts })) });
    endpoints.push({
      endpoint: 'packument-abbreviated',
      ...(await abBenchmark({ url: packumentUrl, header: ABBREVIATED, ...opts })),
    });
    endpoints.push({ endpoint: 'tarball', ...(await abBenchmark({ url: tarballUrl, ...opts })) });

    for (const e of endpoints) {
      h.log(`    ${e.endpoint}: ${Math.round(e.requestsPerSecond ?? 0)} req/s, p95 ${e.latencyMs?.p95 ?? '-'}ms`);
    }

    return { unit, samples: [], extra: { endpoints } };
  } finally {
    await server.stop();
  }
}

async function primeUrl(url, header) {
  const headers = header ? { Accept: header.split(': ')[1] } : undefined;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Priming ${url} failed: ${res.status}`);
  await res.arrayBuffer();
}
