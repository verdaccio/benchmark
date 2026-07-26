import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'fixtures', 'install-mixed');
const resultsDir = path.join(root, 'results');

const defaults = {
  clients: ['npm', 'pnpm', 'yarn'],
  samples: 3,
  portStart: 48730,
  upstreamPort: 48729,
  upstreamSpec: 'latest',
  upstream: 'local',
  tags: {
    latest: 'latest',
    'next-7': 'next-7',
    'next-9': 'next-9',
  },
};

const args = parseArgs(process.argv.slice(2));
const clients = splitArg(args.clients, defaults.clients);
const samples = Number(args.samples ?? defaults.samples);
const versions = parseVersions(args.versions, defaults.tags);
const upstreamMode = args.upstream ?? defaults.upstream;
const upstreamSpec = args['upstream-spec'] ?? defaults.upstreamSpec;

await mkdir(resultsDir, { recursive: true });

const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const rows = [];
let nextPort = defaults.portStart;
const upstream = await prepareUpstream(upstreamMode, upstreamSpec);

try {
  for (const [label, spec] of Object.entries(versions)) {
    for (const client of clients) {
      for (const phase of ['cold', 'warm']) {
        for (let sample = 1; sample <= samples; sample += 1) {
          const durationMs = await measureInstall({
            versionLabel: label,
            versionSpec: spec,
            client,
            phase,
            sample,
            port: nextPort++,
            uplinkUrl: upstream.url,
          });

          rows.push({
            runId,
            versionLabel: label,
            versionSpec: spec,
            client,
            phase,
            sample,
            durationMs: Math.round(durationMs),
          });

          console.log(`${label} ${client} ${phase} sample ${sample}: ${Math.round(durationMs)}ms`);
        }
      }
    }
  }
} finally {
  upstream.stop?.();
}

const summary = summarize(rows);
const payload = { runId, versions, clients, samples, upstream: upstream.info, rows, summary };
await writeFile(path.join(resultsDir, `install-benchmark-${runId}.json`), JSON.stringify(payload, null, 2), 'utf8');
await writeFile(path.join(resultsDir, `install-benchmark-${runId}.csv`), toCsv(rows), 'utf8');

console.table(summary);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    parsed[key] = inlineValue ?? argv[i + 1];
    if (inlineValue === undefined) i += 1;
  }
  return parsed;
}

function splitArg(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseVersions(value, fallback) {
  if (!value) return fallback;
  return Object.fromEntries(
    value.split(',').map((entry) => {
      const [label, spec] = entry.split('=', 2);
      return [label.trim(), spec.trim()];
    })
  );
}

async function prepareUpstream(mode, spec) {
  if (mode === 'npmjs') {
    return {
      url: 'https://registry.npmjs.org/',
      info: { mode, url: 'https://registry.npmjs.org/' },
    };
  }

  if (mode !== 'local') {
    throw new Error(`Unsupported upstream mode: ${mode}`);
  }

  const storageDir = path.join(root, '.cache', 'upstream-storage');
  const configPath = path.join(root, '.cache', 'upstream-config.yaml');
  const url = `http://127.0.0.1:${defaults.upstreamPort}`;

  await mkdir(storageDir, { recursive: true });
  await writeFile(configPath, createVerdaccioConfig(storageDir, 'https://registry.npmjs.org/'), 'utf8');

  const server = await startVerdaccio(spec, configPath, defaults.upstreamPort);
  await primeUpstream(url);

  return {
    url,
    info: { mode, spec, url, storageDir },
    stop: () => server.kill('SIGTERM'),
  };
}

async function primeUpstream(registry) {
  const fixture = await readFile(path.join(fixtureDir, 'package.json'), 'utf8');
  const fixtureHash = createHash('sha256').update(fixture).digest('hex');
  const markerPath = path.join(root, '.cache', 'upstream-fixture.sha256');
  const previousHash = await readFile(markerPath, 'utf8').catch(() => '');

  if (previousHash.trim() === fixtureHash) {
    return;
  }

  const projectDir = await prepareProject('upstream', 'npm', 'prime', Date.now());
  const cacheDir = path.join(root, '.cache', 'upstream-client-cache');

  try {
    await run(...installCommand('npm', registry, cacheDir), projectDir);
    await writeFile(markerPath, `${fixtureHash}\n`, 'utf8');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function createVerdaccioConfig(storageDir, uplinkUrl) {
  const htpasswdPath = path.join(storageDir, 'htpasswd');
  return [
    `storage: ${storageDir}`,
    'auth:',
    '  htpasswd:',
    `    file: ${htpasswdPath}`,
    'uplinks:',
    '  npmjs:',
    `    url: ${uplinkUrl}`,
    'packages:',
    "  '@*/*':",
    '    access: $all',
    '    publish: $authenticated',
    '    proxy: npmjs',
    "  '**':",
    '    access: $all',
    '    publish: $authenticated',
    '    proxy: npmjs',
    'logs:',
    '  - {type: stdout, format: pretty, level: error}',
    '',
  ].join('\n');
}

async function measureInstall({ versionLabel, versionSpec, client, phase, sample, port, uplinkUrl }) {
  const workRoot = await mkdtemp(path.join(tmpdir(), `verdaccio-bench-${versionLabel}-${client}-${phase}-${sample}-`));
  const storageDir = path.join(workRoot, 'storage');
  const configPath = path.join(workRoot, 'config.yaml');
  const registry = `http://127.0.0.1:${port}`;

  await mkdir(storageDir, { recursive: true });
  await writeFile(configPath, createVerdaccioConfig(storageDir, uplinkUrl), 'utf8');

  const server = await startVerdaccio(versionSpec, configPath, port);

  try {
    if (phase === 'warm') {
      const primeProjectDir = await prepareProject(versionLabel, client, phase, `${sample}-prime`);
      const primeCacheDir = path.join(workRoot, 'client-cache', client, 'prime');
      await run(...installCommand(client, registry, primeCacheDir), primeProjectDir);
      await rm(primeProjectDir, { recursive: true, force: true });
    }

    const projectDir = await prepareProject(versionLabel, client, phase, sample);
    const cacheDir = path.join(workRoot, 'client-cache', client, 'measured');
    const durationMs = await timeCommand(installCommand(client, registry, cacheDir), projectDir);
    await rm(projectDir, { recursive: true, force: true });
    return durationMs;
  } finally {
    server.kill('SIGTERM');
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function startVerdaccio(spec, configPath, port) {
  const child = spawn('npx', ['--yes', `verdaccio@${spec}`, '--config', configPath, '--listen', `127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  await waitForHttp(`http://127.0.0.1:${port}/-/ping`, 60_000, () => output, child);
  return child;
}

async function waitForHttp(url, timeoutMs, getOutput, child) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Verdaccio exited with ${child.exitCode}\n${getOutput()}`);
    }
    if (await canGet(url)) return;
    await sleep(250);
  }
  throw new Error(`Verdaccio did not start within ${timeoutMs}ms\n${getOutput()}`);
}

function canGet(url) {
  return fetch(url).then((response) => response.ok).catch(() => false);
}

async function prepareProject(versionLabel, client, phase, sample) {
  const projectDir = await mkdtemp(path.join(tmpdir(), `verdaccio-install-${versionLabel}-${client}-${phase}-${sample}-`));
  const fixture = await readFile(path.join(fixtureDir, 'package.json'), 'utf8');
  await writeFile(path.join(projectDir, 'package.json'), fixture, 'utf8');
  return projectDir;
}

function installCommand(client, registry, cacheDir) {
  if (client === 'npm') {
    return ['npm', ['install', '--registry', registry, '--cache', cacheDir, '--prefer-online', '--no-audit', '--no-fund']];
  }
  if (client === 'pnpm') {
    return ['pnpm', ['install', '--registry', registry, '--store-dir', cacheDir, '--config.confirmModulesPurge=false']];
  }
  if (client === 'yarn') {
    return ['yarn', ['install', '--registry', registry, '--cache-folder', cacheDir, '--ignore-scripts']];
  }
  throw new Error(`Unsupported client: ${client}`);
}

async function timeCommand([cmd, cmdArgs], cwd) {
  const started = performance.now();
  await run(cmd, cmdArgs, cwd);
  return performance.now() - started;
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} ${args.join(' ')} failed with ${code}\n${output}`));
      }
    });
  });
}

function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.versionLabel}|${row.client}|${row.phase}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.durationMs);
  }

  return [...groups.entries()].map(([key, values]) => {
    const [versionLabel, client, phase] = key.split('|');
    const sorted = values.toSorted((a, b) => a - b);
    return {
      versionLabel,
      client,
      phase,
      samples: sorted.length,
      medianMs: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      minMs: sorted[0],
      maxMs: sorted.at(-1),
    };
  });
}

function percentile(sortedValues, p) {
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function toCsv(rows) {
  const headers = ['runId', 'versionLabel', 'versionSpec', 'client', 'phase', 'sample', 'durationMs'];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => JSON.stringify(row[header])).join(',')),
    '',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
