import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, parseVersions, splitArg } from './lib/args.mjs';
import { captureEnv } from './lib/env.mjs';
import { getFreePort } from './lib/net.mjs';
import { makeProject, removeDir, scratchDir, timeInstall } from './lib/npm.mjs';
import { run } from './lib/proc.mjs';
import {
  createConfig,
  installBinary,
  resolveVersion,
  startVerdaccio,
} from './lib/verdaccio.mjs';
import { summarizeSamples } from './lib/stats.mjs';
import { scenarioNames, scenarios } from './scenarios/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'fixtures', 'install-mixed');
const resultsDir = path.join(root, 'results');
const binRoot = path.join(root, '.cache', 'bin');

const defaults = {
  versions: { latest: 'latest', 'next-7': 'next-7', 'next-9': 'next-9' },
  scenarios: scenarioNames, // all scenarios by default
  // 20 samples: enough for a stable median AND a meaningful p95 in a single
  // publishable report. Override with --samples for quick iteration.
  samples: 20,
  warmup: 2,
  upstream: 'local', // 'local' (primed Verdaccio) or 'npmjs'
  upstreamSpec: 'latest',
  serveRequests: 2000,
  serveConcurrency: 20,
};

const args = parseArgs(process.argv.slice(2));
const versions = parseVersions(args.versions, defaults.versions);
const selectedScenarios = splitArg(args.scenarios, defaults.scenarios);
const samples = Number(args.samples ?? defaults.samples);
const warmup = Number(args.warmup ?? defaults.warmup);
// --frozen serves a fixed snapshot (offline) so metadata bytes stay constant
// across runs; otherwise 'local' re-primes from npmjs and packuments grow.
const upstreamMode = args.frozen ? 'frozen' : args.upstream ?? defaults.upstream;
const upstreamSpec = args['upstream-spec'] ?? defaults.upstreamSpec;
const serveRequests = Number(args['serve-requests'] ?? defaults.serveRequests);
const serveConcurrency = Number(args['serve-concurrency'] ?? defaults.serveConcurrency);

for (const name of selectedScenarios) {
  if (!scenarios[name]) {
    throw new Error(`Unknown scenario "${name}". Available: ${scenarioNames.join(', ')}`);
  }
}

await mkdir(resultsDir, { recursive: true });

const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const env = await captureEnv();
const fixture = JSON.parse(await readFile(path.join(fixtureDir, 'package.json'), 'utf8'));

console.log(`Run ${runId}`);
console.log(`Scenarios: ${selectedScenarios.join(', ')} | samples: ${samples} (+${warmup} warmup) | upstream: ${upstreamMode}`);

// Resolve tags to exact versions once, up front, and record them.
const resolved = {};
for (const [label, spec] of Object.entries(versions)) {
  resolved[label] = await resolveVersion(spec);
  console.log(`  ${label}: verdaccio@${spec} -> ${resolved[label]}`);
}

// Install each distinct Verdaccio version once into its own prefix.
const binPaths = {};
for (const version of new Set(Object.values(resolved))) {
  process.stdout.write(`Installing verdaccio@${version} ... `);
  binPaths[version] = await installBinary(version, binRoot);
  console.log('done');
}

const upstream = await prepareUpstream(upstreamMode, upstreamSpec);
const rows = [];

try {
  for (const scenarioName of selectedScenarios) {
    const scenario = scenarios[scenarioName];
    for (const [label, spec] of Object.entries(versions)) {
      const version = resolved[label];
      console.log(`\n[${scenarioName}] ${label} (verdaccio@${version})`);

      const harness = makeHarness({ version, upstreamUrl: upstream.url });
      const result = await scenario.run(harness);

      rows.push({
        scenario: scenarioName,
        versionLabel: label,
        versionSpec: spec,
        version,
        unit: result.unit,
        samples: result.samples,
        extra: result.extra ?? null,
      });
    }
  }
} finally {
  await upstream.stop?.();
}

const summary = rows.map((row) => ({
  scenario: row.scenario,
  versionLabel: row.versionLabel,
  version: row.version,
  unit: row.unit,
  ...(row.unit === 'ms' ? summarizeSamples(row.samples) : { extra: row.extra }),
}));

const payload = {
  runId,
  env,
  upstream: upstream.info,
  fixture: { dependencies: fixture.dependencies ?? {} },
  versions: resolved,
  samples,
  warmup,
  rows,
  summary,
};

const jsonPath = path.join(resultsDir, `bench-${runId}.json`);
const csvPath = path.join(resultsDir, `bench-${runId}.csv`);
await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
await writeFile(csvPath, toCsv(summary), 'utf8');

console.log('\nSummary:');
console.table(
  summary.map((s) => ({
    scenario: s.scenario,
    version: s.versionLabel,
    unit: s.unit,
    median: s.medianMs ?? '-',
    p95: s.p95Ms ?? '-',
    min: s.minMs ?? '-',
    max: s.maxMs ?? '-',
  }))
);
console.log(`\nWrote ${path.relative(root, jsonPath)}`);
console.log(`Wrote ${path.relative(root, csvPath)}`);

// --- harness wiring -------------------------------------------------------

function makeHarness({ version, upstreamUrl }) {
  return {
    version,
    upstreamUrl,
    fixture,
    samples,
    warmup,
    serveRequests,
    serveConcurrency,
    root,
    log: (msg) => console.log(msg),
    startTarget: () => startTarget(binPaths[version], upstreamUrl),
  };
}

async function startTarget(binPath, upstreamUrl) {
  const workRoot = await scratchDir('vbench-target-');
  const storageDir = path.join(workRoot, 'storage');
  await mkdir(storageDir, { recursive: true });
  const configPath = path.join(workRoot, 'config.yaml');
  await writeFile(configPath, createConfig({ storageDir, uplinkUrl: upstreamUrl }), 'utf8');
  const port = await getFreePort();
  const server = await startVerdaccio({ binPath, configPath, port });

  return {
    registry: server.registry,
    storageDir,
    child: server.child,
    stop: async () => {
      await server.stop();
      await removeDir(workRoot);
    },
  };
}

// A warm local upstream (Verdaccio primed with the fixture deps) removes npmjs
// network noise from proxy scenarios. Priming is cached across runs by hashing
// the fixture.
async function prepareUpstream(mode, spec) {
  if (mode === 'npmjs') {
    return { url: 'https://registry.npmjs.org/', info: { mode, url: 'https://registry.npmjs.org/' }, stop: undefined };
  }
  if (mode === 'frozen') return prepareFrozenUpstream(spec);
  if (mode !== 'local') throw new Error(`Unsupported upstream mode: ${mode}`);

  const version = await resolveVersion(spec);
  const binPath = binPaths[version] ?? (await installBinary(version, binRoot));
  const storageDir = path.join(root, '.cache', 'upstream-storage');
  const configPath = path.join(root, '.cache', 'upstream-config.yaml');
  await mkdir(storageDir, { recursive: true });
  await writeFile(configPath, createConfig({ storageDir, uplinkUrl: 'https://registry.npmjs.org/' }), 'utf8');

  const port = await getFreePort();
  const server = await startVerdaccio({ binPath, configPath, port });
  await primeUpstream(server.registry);

  return {
    url: server.registry,
    info: { mode, spec, version, url: server.registry, storageDir },
    stop: () => server.stop(),
  };
}

// Restore the committed snapshot and serve it OFFLINE, so every run — today or in
// a year — sees byte-identical packuments and tarballs. Requires `pnpm snapshot`.
async function prepareFrozenUpstream(spec) {
  const snapshotTar = path.join(root, '.cache', 'upstream-snapshot.tar.gz');
  const manifestPath = path.join(root, '.cache', 'upstream-snapshot.manifest.json');
  const ok = await access(snapshotTar).then(() => true).catch(() => false);
  if (!ok) {
    throw new Error(`No frozen snapshot at ${path.relative(root, snapshotTar)}. Create one with:  pnpm snapshot`);
  }
  const manifest = await readFile(manifestPath, 'utf8').then((r) => JSON.parse(r)).catch(() => null);

  const version = await resolveVersion(spec);
  const binPath = binPaths[version] ?? (await installBinary(version, binRoot));
  const workRoot = await scratchDir('vbench-frozen-');
  const storageDir = path.join(workRoot, 'storage');
  await mkdir(storageDir, { recursive: true });
  await run('tar', ['-xzf', snapshotTar, '-C', storageDir]);

  const configPath = path.join(workRoot, 'config.yaml');
  await writeFile(configPath, createConfig({ storageDir, offline: true }), 'utf8');
  const port = await getFreePort();
  const server = await startVerdaccio({ binPath, configPath, port });

  console.log(`Frozen upstream: snapshot ${manifest?.snapshot?.sha256?.slice(0, 12) ?? '?'}… (${manifest?.createdAt?.slice(0, 10) ?? 'unknown date'})`);
  return {
    url: server.registry,
    info: { mode: 'frozen', version, url: server.registry, snapshot: manifest?.snapshot ?? null, snapshotCreatedAt: manifest?.createdAt ?? null },
    stop: async () => {
      await server.stop();
      await removeDir(workRoot);
    },
  };
}

async function primeUpstream(registry) {
  const fixtureRaw = await readFile(path.join(fixtureDir, 'package.json'), 'utf8');
  const fixtureHash = createHash('sha256').update(fixtureRaw).digest('hex');
  const markerPath = path.join(root, '.cache', 'upstream-fixture.sha256');
  const previousHash = await readFile(markerPath, 'utf8').catch(() => '');
  if (previousHash.trim() === fixtureHash) return;

  console.log('Priming local upstream with fixture dependencies ...');
  const cacheDir = await scratchDir('vbench-prime-cache-');
  const projectDir = await makeProject({ packageJson: fixture, registry });
  try {
    await timeInstall({ registry, cacheDir, projectDir, preferOnline: true });
    await writeFile(markerPath, `${fixtureHash}\n`, 'utf8');
  } finally {
    await removeDir(projectDir);
    await removeDir(cacheDir);
  }
}

function toCsv(summary) {
  const headers = ['scenario', 'versionLabel', 'version', 'unit', 'samples', 'meanMs', 'medianMs', 'p90Ms', 'p95Ms', 'minMs', 'maxMs', 'stddevMs'];
  return [
    headers.join(','),
    ...summary.map((row) => headers.map((h) => JSON.stringify(row[h] ?? '')).join(',')),
    '',
  ].join('\n');
}
