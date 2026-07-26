import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'fixtures', 'install-mixed');
const args = parseArgs(process.argv.slice(2));

const client = args.client ?? 'npm';
const registry = args.registry;

if (!registry) {
  throw new Error('Missing required --registry');
}

const projectDir = await mkdtemp(path.join(tmpdir(), `verdaccio-install-${client}-`));
const cacheDir = await mkdtemp(path.join(tmpdir(), `verdaccio-install-cache-${client}-`));

try {
  const fixture = await readFile(path.join(fixtureDir, 'package.json'), 'utf8');
  await writeFile(path.join(projectDir, 'package.json'), fixture, 'utf8');
  await run(...installCommand(client, registry, cacheDir), projectDir);
} finally {
  await rm(projectDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
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
