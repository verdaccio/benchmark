import { run } from './proc.mjs';

// Drive ApacheBench (`ab`) against a single URL and parse the fields we care
// about: throughput and the latency percentile table. `ab` benchmarks a raw
// HTTP endpoint, which isolates Verdaccio's own serving cost from npm's
// resolution/extraction work.
export async function abBenchmark({ url, requests, concurrency, header }) {
  const args = ['-n', String(requests), '-c', String(concurrency)];
  if (header) args.push('-H', header);
  args.push(url);

  // ab exits non-zero on some non-2xx responses; capture output either way.
  const output = await run('ab', args).catch((err) => err.message);
  return parseAb(output, { url, requests, concurrency });
}

export function parseAb(output, meta) {
  const number = (re) => {
    const match = output.match(re);
    return match ? Number(match[1]) : null;
  };

  const percentiles = {};
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(\d+)%\s+(\d+)/);
    if (m) percentiles[`p${m[1]}`] = Number(m[2]);
  }

  return {
    ...meta,
    completeRequests: number(/Complete requests:\s+(\d+)/),
    failedRequests: number(/Failed requests:\s+(\d+)/),
    non2xx: number(/Non-2xx responses:\s+(\d+)/) ?? 0,
    requestsPerSecond: number(/Requests per second:\s+([\d.]+)/),
    timePerRequestMeanMs: number(/Time per request:\s+([\d.]+)\s+\[ms\]\s+\(mean\)/),
    transferRateKbps: number(/Transfer rate:\s+([\d.]+)/),
    latencyMs: {
      p50: percentiles.p50 ?? null,
      p90: percentiles.p90 ?? null,
      p95: percentiles.p95 ?? null,
      p99: percentiles.p99 ?? null,
      max: percentiles.p100 ?? null,
    },
  };
}
