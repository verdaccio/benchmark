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
  ensureImage,
  imageInfo,
  installBinary,
  resolveSpec,
  resolveVersion,
  selfDockerNetwork,
  startVerdaccio,
  startVerdaccioImage,
  startVerdaccioImageDood,
} from './lib/verdaccio.mjs';
import { summarizeSamples } from './lib/stats.mjs';
import { defaultScenarioNames, scenarioNames, scenarios } from './scenarios/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'fixtures', 'install-mixed');
const binRoot = path.join(root, '.cache', 'bin');

const defaults = {
  versions: { latest: 'latest', 'next-7': 'next-7', 'next-9': 'next-9' },
  scenarios: defaultScenarioNames, // all non-opt-in scenarios by default
  // 20 samples: enough for a stable median AND a meaningful p95 in a single
  // publishable report. Override with --samples for quick iteration.
  samples: 20,
  warmup: 2,
  upstream: 'local', // 'local' (primed Verdaccio) or 'npmjs'
  upstreamSpec: 'latest',
  serveRequests: 2000,
  serveConcurrency: 20,
  monorepoPackages: 400,
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
const monorepoPackages = Number(args['monorepo-packages'] ?? defaults.monorepoPackages);
// Packages served by the `bigpkg` scenario (large packuments). Override with
// --filter-packages typescript,next,react to change the set.
const bigpkgPackages = splitArg(args['filter-packages'], ['typescript', 'next', '@types/node', 'react', 'aws-sdk', 'eslint']);
// Extra per-package pass: also publish each package individually with `npm publish`
// (serial, timed) to get a per-package latency distribution alongside lerna's total.
const monorepoPerPackage = args['monorepo-per-package'] === true || args['monorepo-per-package'] === 'true';
// --legacy-auth-cache enables server.legacyAuthCache on the TARGET (Verdaccio 7.x/9.x):
// caches legacy Bearer-token validations so bcrypt isn't re-run per request. Optional
// --legacy-auth-cache-ttl <ms> tunes the cache TTL.
const legacyAuthCacheOn = args['legacy-auth-cache'] === true || args['legacy-auth-cache'] === 'true';
const legacyAuthCacheOpts = { ttlMs: args['legacy-auth-cache-ttl'] ? Number(args['legacy-auth-cache-ttl']) : undefined };
const legacyAuthCache = legacyAuthCacheOn ? legacyAuthCacheOpts : false;
// --legacy-auth-cache-compare runs EACH version twice — cache off and on — in one
// benchmark, labeled `<v>` and `<v>+cache`, so a report shows them side by side.
const legacyAuthCacheCompare =
  args['legacy-auth-cache-compare'] === true || args['legacy-auth-cache-compare'] === 'true';
// --package-filter enables the @verdaccio/package-filter on the target (7.x/9.x):
// filter_metadata runs on every packument read. Off unless requested.
const packageFilter = args['package-filter'] === true || args['package-filter'] === 'true';
// Real filter rules that force per-version work (vs the {} no-op). Any of these
// implies the filter is enabled.
const filterRules = {};
if (args['filter-min-age'] !== undefined) filterRules.minAgeDays = Number(args['filter-min-age']);
if (typeof args['filter-date'] === 'string') filterRules.dateThreshold = args['filter-date'];
if (args['filter-exclude-deprecated'] === true || args['filter-exclude-deprecated'] === 'true')
  filterRules.excludeDeprecated = true;
const hasFilterRules = Object.keys(filterRules).length > 0;
// The value passed to createConfig's packageFilter: rules object if given, else a
// no-op `true` when --package-filter is set, else false (no filter).
const packageFilterValue = hasFilterRules ? filterRules : packageFilter;
const packageFilterOn = Boolean(packageFilterValue);
// --package-filter-compare runs each version twice (filter off + on), labeled
// `<v>` and `<v>+filter`, to isolate the filter's per-read cost.
const packageFilterCompare =
  args['package-filter-compare'] === true || args['package-filter-compare'] === 'true';
if (packageFilterCompare && legacyAuthCacheCompare) {
  throw new Error('Use only one of --package-filter-compare / --legacy-auth-cache-compare per run.');
}
// --out-dir writes results somewhere other than results/ (e.g. an OS temp dir),
// so throwaway comparison runs leave nothing behind and never touch runs.json.
const resultsDir = args['out-dir'] ? path.resolve(args['out-dir']) : path.join(root, 'results');

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
const filterRulesLabel = hasFilterRules ? JSON.stringify(filterRules) : 'no-op {}';
const filterLabel = packageFilterCompare
  ? `compare (off vs ${filterRulesLabel})`
  : packageFilterOn
    ? filterRulesLabel
    : 'off';
const lacLabel = legacyAuthCacheCompare
  ? 'compare (off vs on)'
  : legacyAuthCacheOn
    ? `on (ttl ${legacyAuthCacheOpts.ttlMs ?? 30000}ms)`
    : 'off';
console.log(
  `Scenarios: ${selectedScenarios.join(', ')} | samples: ${samples} (+${warmup} warmup) | upstream: ${upstreamMode}` +
    ` | legacyAuthCache: ${lacLabel} | packageFilter: ${filterLabel}`
);

// Resolve each spec once, up front, and record it. A spec ending in .tgz/.tar.gz
// is a local unpublished tarball (looked up in tarballs/); everything else is a
// published tag/version. `installSpecs` maps the resolved identity to what npm
// should install (a tarball path or verdaccio@<version>).
const resolved = {};
const specByVersion = {};
for (const [label, spec] of Object.entries(versions)) {
  const info = await resolveSpec(spec, root);
  resolved[label] = info.version;
  specByVersion[info.version] = info;
  console.log(`  ${label}: ${spec} -> ${info.version}`);
}

// Prepare each distinct target once: pull the Docker image, or install the npm
// package / local tarball binary into its own prefix.
const targets = {};
const sources = {}; // version identity -> where it came from (npm / tarball / docker image + digest)
for (const version of new Set(Object.values(resolved))) {
  const { install, image } = specByVersion[version];
  if (image) {
    process.stdout.write(`Image ${image} ... `);
    const how = await ensureImage(image);
    const info = await imageInfo(image);
    process.stdout.write(`(${how}${info.created ? `, built ${info.created}` : ''}) `);
    targets[version] = { kind: 'docker', image };
    sources[version] = { kind: 'docker', ref: image, digest: info.digest, built: info.created };
  } else {
    process.stdout.write(`Installing ${install} ... `);
    targets[version] = { kind: 'binary', binPath: await installBinary(version, binRoot, install) };
    sources[version] = { kind: install.endsWith('.tgz') || install.endsWith('.tar.gz') ? 'tarball' : 'npm', ref: install };
  }
  console.log('done');
}
// If any target runs as a container, the upstream must listen on 0.0.0.0 so the
// target can reach it via host.docker.internal (loopback-only would refuse).
const hasDockerTarget = Object.values(targets).some((t) => t.kind === 'docker');

// Docker-out-of-docker target state (used by startDockerTarget); declared before
// the run loop so the hoisted function can reach it without a TDZ error.
let dockerNet = null; // memoized {network, ip} when running in-container
let targetSeq = 0;

// Expand versions into concrete run targets. Normally one per version; in
// --legacy-auth-cache-compare mode, two per version (cache off + on) sharing the
// same installed binary/image but distinct report identities.
const runVersions = [];
for (const [label, spec] of Object.entries(versions)) {
  const id = resolved[label];
  if (legacyAuthCacheCompare) {
    runVersions.push({ label, version: id, installVersion: id, spec, cache: false, filter: packageFilterValue });
    runVersions.push({ label: `${label}+cache`, version: `${id}+cache`, installVersion: id, spec, cache: legacyAuthCacheOpts, filter: packageFilterValue });
  } else if (packageFilterCompare) {
    const onFilter = hasFilterRules ? filterRules : true;
    runVersions.push({ label, version: id, installVersion: id, spec, cache: legacyAuthCache, filter: false });
    runVersions.push({ label: `${label}+filter`, version: `${id}+filter`, installVersion: id, spec, cache: legacyAuthCache, filter: onFilter });
  } else {
    runVersions.push({ label, version: id, installVersion: id, spec, cache: legacyAuthCache, filter: packageFilterValue });
  }
}

const upstream = await prepareUpstream(upstreamMode, upstreamSpec, { bindAll: hasDockerTarget });
const rows = [];

try {
  for (const scenarioName of selectedScenarios) {
    const scenario = scenarios[scenarioName];
    for (const rv of runVersions) {
      console.log(`\n[${scenarioName}] ${rv.label} (verdaccio@${rv.version})`);

      const harness = makeHarness(rv);
      const result = await scenario.run(harness);

      rows.push({
        scenario: scenarioName,
        versionLabel: rv.label,
        versionSpec: rv.spec,
        version: rv.version,
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
  settings: {
    legacyAuthCache: legacyAuthCacheCompare ? 'compare' : legacyAuthCacheOn ? (legacyAuthCacheOpts.ttlMs ?? 30000) : false,
    packageFilter: packageFilterCompare ? { compare: true, rules: hasFilterRules ? filterRules : 'no-op' } : packageFilterValue,
    serveRequests,
    serveConcurrency,
  },
  fixture: { dependencies: fixture.dependencies ?? {} },
  versions: resolved,
  sources,
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

function makeHarness(rv) {
  return {
    version: rv.version,
    upstreamUrl: upstream.url,
    fixture,
    samples,
    warmup,
    serveRequests,
    serveConcurrency,
    monorepoPackages,
    monorepoPerPackage,
    bigpkgPackages,
    root,
    log: (msg) => console.log(msg),
    startTarget: () => startTarget(targets[rv.installVersion], upstream.url, { cache: rv.cache, filter: rv.filter }),
  };
}

async function startTarget(target, upstreamUrl, { cache, filter } = {}) {
  if (target.kind === 'docker') return startDockerTarget(target.image, upstreamUrl, { cache, filter });

  const workRoot = await scratchDir('vbench-target-');
  const storageDir = path.join(workRoot, 'storage');
  await mkdir(storageDir, { recursive: true });
  const configPath = path.join(workRoot, 'config.yaml');
  await writeFile(
    configPath,
    createConfig({ storageDir, uplinkUrl: upstreamUrl, legacyAuthCache: cache, packageFilter: filter }),
    'utf8'
  );
  const port = await getFreePort();
  const server = await startVerdaccio({ binPath: target.binPath, configPath, port });

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

// Target that runs as a Docker container. Storage is container-internal (fresh
// per run). Two modes:
//  - host harness: publish the port to 127.0.0.1, uplink via host.docker.internal.
//  - in-container harness (VBENCH_IN_CONTAINER, docker-out-of-docker): launch the
//    image as a sibling on the harness's own network, reach it by name, and point
//    its uplink at the harness's own container IP.
async function startDockerTarget(image, upstreamUrl, { cache, filter } = {}) {
  const workRoot = await scratchDir('vbench-target-');
  const configPath = path.join(workRoot, 'config.yaml');
  const stop = async (server) => {
    await server.stop();
    await removeDir(workRoot);
  };

  if (process.env.VBENCH_IN_CONTAINER === '1') {
    dockerNet ??= await selfDockerNetwork();
    const uplinkUrl = upstreamUrl ? upstreamUrl.replace(/127\.0\.0\.1|localhost/, dockerNet.ip) : upstreamUrl;
    await writeFile(configPath, createConfig({ storageDir: '/verdaccio/storage', uplinkUrl, legacyAuthCache: cache, packageFilter: filter }), 'utf8');
    const name = `vbench-target-${process.pid}-${targetSeq++}`;
    const server = await startVerdaccioImageDood({ image, configPath, name, network: dockerNet.network });
    return { registry: server.registry, storageDir: null, child: null, stop: () => stop(server) };
  }

  const uplinkUrl = upstreamUrl ? upstreamUrl.replace(/127\.0\.0\.1|localhost/, 'host.docker.internal') : upstreamUrl;
  await writeFile(configPath, createConfig({ storageDir: '/verdaccio/storage', uplinkUrl, legacyAuthCache: cache, packageFilter: filter }), 'utf8');
  const port = await getFreePort();
  const server = await startVerdaccioImage({ image, configPath, port });
  return { registry: server.registry, storageDir: null, child: null, stop: () => stop(server) };
}

// A warm local upstream (Verdaccio primed with the fixture deps) removes npmjs
// network noise from proxy scenarios. Priming is cached across runs by hashing
// the fixture.
async function prepareUpstream(mode, spec, { bindAll = false } = {}) {
  if (mode === 'npmjs') {
    return { url: 'https://registry.npmjs.org/', info: { mode, url: 'https://registry.npmjs.org/' }, stop: undefined };
  }
  if (mode === 'frozen') return prepareFrozenUpstream(spec, { bindAll });
  if (mode !== 'local') throw new Error(`Unsupported upstream mode: ${mode}`);

  const host = bindAll ? '0.0.0.0' : '127.0.0.1';
  const version = await resolveVersion(spec);
  const binPath = targets[version]?.binPath ?? (await installBinary(version, binRoot));
  const storageDir = path.join(root, '.cache', 'upstream-storage');
  const configPath = path.join(root, '.cache', 'upstream-config.yaml');
  await mkdir(storageDir, { recursive: true });
  await writeFile(configPath, createConfig({ storageDir, uplinkUrl: 'https://registry.npmjs.org/' }), 'utf8');

  const port = await getFreePort();
  const server = await startVerdaccio({ binPath, configPath, port, host });
  await primeUpstream(server.registry);

  return {
    url: server.registry,
    info: { mode, spec, version, url: server.registry, storageDir },
    stop: () => server.stop(),
  };
}

// Restore the committed snapshot and serve it OFFLINE, so every run — today or in
// a year — sees byte-identical packuments and tarballs. Requires `pnpm snapshot`.
async function prepareFrozenUpstream(spec, { bindAll = false } = {}) {
  const snapshotTar = path.join(root, '.cache', 'upstream-snapshot.tar.gz');
  const manifestPath = path.join(root, '.cache', 'upstream-snapshot.manifest.json');
  const ok = await access(snapshotTar).then(() => true).catch(() => false);
  if (!ok) {
    throw new Error(`No frozen snapshot at ${path.relative(root, snapshotTar)}. Create one with:  pnpm snapshot`);
  }
  const manifest = await readFile(manifestPath, 'utf8').then((r) => JSON.parse(r)).catch(() => null);

  const version = await resolveVersion(spec);
  const binPath = targets[version]?.binPath ?? (await installBinary(version, binRoot));
  const workRoot = await scratchDir('vbench-frozen-');
  const storageDir = path.join(workRoot, 'storage');
  await mkdir(storageDir, { recursive: true });
  await run('tar', ['-xzf', snapshotTar, '-C', storageDir]);

  const configPath = path.join(workRoot, 'config.yaml');
  await writeFile(configPath, createConfig({ storageDir, offline: true }), 'utf8');
  const port = await getFreePort();
  const server = await startVerdaccio({ binPath, configPath, port, host: bindAll ? '0.0.0.0' : '127.0.0.1' });

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
