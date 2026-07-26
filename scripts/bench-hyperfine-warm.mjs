import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'fixtures', 'install-mixed');
const resultsDir = path.join(root, 'results');
const installOncePath = path.join(root, 'scripts', 'install-once.mjs');

const defaults = {
  clients: ['npm'],
  runs: 5,
  warmup: 1,
  portStart: 48830,
  upstreamPort: 48829,
  upstreamSpec: 'latest',
  tags: {
    latest: 'latest',
    'next-7': 'next-7',
    'next-9': 'next-9',
  },
};

const args = parseArgs(process.argv.slice(2));
const clients = splitArg(args.clients, defaults.clients);
const runs = Number(args.runs ?? defaults.runs);
const warmup = Number(args.warmup ?? defaults.warmup);
const versions = parseVersions(args.versions, defaults.tags);
const upstreamSpec = args['upstream-spec'] ?? defaults.upstreamSpec;

await mkdir(resultsDir, { recursive: true });

const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const upstream = await prepareUpstream(upstreamSpec);
const targets = [];

try {
  let port = defaults.portStart;
  for (const [label, spec] of Object.entries(versions)) {
    const target = await startTarget(label, spec, port++, upstream.url);
    targets.push(target);
  }

  for (const client of clients) {
    for (const target of targets) {
      await run('node', [installOncePath, '--client', client, '--registry', target.registry], root);
    }

    const outputBase = path.join(resultsDir, `hyperfine-warm-${client}-${runId}`);
    const hyperfineArgs = [
      '--runs',
      String(runs),
      '--warmup',
      String(warmup),
      '--export-json',
      `${outputBase}.json`,
      '--export-csv',
      `${outputBase}.csv`,
    ];

    for (const target of targets) {
      hyperfineArgs.push(
        '--command-name',
        `${target.label} ${client} warm`,
        `node ${JSON.stringify(installOncePath)} --client ${client} --registry ${target.registry}`
      );
    }

    await run('hyperfine', hyperfineArgs, root, 'inherit');
  }
} finally {
  for (const target of targets) target.stop();
  upstream.stop();
}

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

async function prepareUpstream(spec) {
  const storageDir = path.join(root, '.cache', 'upstream-storage');
  const configPath = path.join(root, '.cache', 'upstream-config.yaml');
  const url = `http://127.0.0.1:${defaults.upstreamPort}`;

  await mkdir(storageDir, { recursive: true });
  await writeFile(configPath, createVerdaccioConfig(storageDir, 'https://registry.npmjs.org/'), 'utf8');

  const server = await startVerdaccio(spec, configPath, defaults.upstreamPort);
  await primeUpstream(url);

  return {
    url,
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

  await run('node', [installOncePath, '--client', 'npm', '--registry', registry], root);
  await writeFile(markerPath, `${fixtureHash}\n`, 'utf8');
}

async function startTarget(label, spec, port, uplinkUrl) {
  const workRoot = await mkdtemp(path.join(tmpdir(), `verdaccio-hyperfine-${label}-`));
  const storageDir = path.join(workRoot, 'storage');
  const configPath = path.join(workRoot, 'config.yaml');
  const registry = `http://127.0.0.1:${port}`;

  await mkdir(storageDir, { recursive: true });
  await writeFile(configPath, createVerdaccioConfig(storageDir, uplinkUrl), 'utf8');

  const server = await startVerdaccio(spec, configPath, port);

  return {
    label,
    registry,
    stop: () => {
      server.kill('SIGTERM');
      void rm(workRoot, { recursive: true, force: true });
    },
  };
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
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`Verdaccio did not start within ${timeoutMs}ms\n${getOutput()}`);
}

function run(cmd, args, cwd, stdio = 'pipe') {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let output = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });
    }
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} ${args.join(' ')} failed with ${code}\n${output}`));
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
