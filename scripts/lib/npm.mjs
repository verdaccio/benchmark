import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, timeCommand } from './proc.mjs';

// Create an isolated project dir containing the given package.json.
// An optional authToken writes an .npmrc so publish/unpublish can authenticate.
export async function makeProject({ packageJson, registry, authToken, files = {} }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vbench-project-'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');

  const npmrc = [`registry=${registry}`];
  if (authToken) {
    // Strip protocol; npm keys auth by //host/path.
    const hostPath = registry.replace(/^https?:/, '');
    npmrc.push(`${hostPath.replace(/\/?$/, '/')}:_authToken=${authToken}`);
  }
  await writeFile(path.join(dir, '.npmrc'), `${npmrc.join('\n')}\n`, 'utf8');

  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

// A small, self-contained package used by the publish/unpublish scenarios.
// Kept tiny so timings reflect Verdaccio's publish/unpublish handling rather
// than upload/transfer size.
export const TEST_PACKAGE_NAME = 'verdaccio-bench-artifact';

export function buildTestPackage(version) {
  return {
    packageJson: {
      name: TEST_PACKAGE_NAME,
      version,
      description: 'Synthetic package for Verdaccio publish/unpublish benchmarking.',
      main: 'index.js',
      license: 'MIT',
    },
    files: {
      'index.js': `module.exports = ${JSON.stringify(version)};\n`,
      'README.md': `# ${TEST_PACKAGE_NAME}\n\nBenchmark artifact ${version}.\n`,
    },
  };
}

const commonInstallFlags = ['--no-audit', '--no-fund', '--loglevel', 'error'];

// npm install args. `preferOnline` forces metadata revalidation (cache-miss-ish
// behavior); leave it off for the warm-cache scenario.
export function installArgs({ registry, cacheDir, preferOnline = false }) {
  return [
    'install',
    '--registry',
    registry,
    '--cache',
    cacheDir,
    ...(preferOnline ? ['--prefer-online'] : []),
    ...commonInstallFlags,
  ];
}

export async function timeInstall({ registry, cacheDir, projectDir, preferOnline }) {
  return timeCommand('npm', installArgs({ registry, cacheDir, preferOnline }), { cwd: projectDir });
}

export async function timePublish({ projectDir, registry, cacheDir }) {
  return timeCommand('npm', ['publish', '--registry', registry, '--cache', cacheDir, '--loglevel', 'error'], {
    cwd: projectDir,
  });
}

export async function timeUnpublish({ spec, registry, cacheDir, projectDir }) {
  return timeCommand(
    'npm',
    ['unpublish', spec, '--force', '--registry', registry, '--cache', cacheDir, '--loglevel', 'error'],
    { cwd: projectDir }
  );
}

export async function publish({ projectDir, registry, cacheDir }) {
  await run('npm', ['publish', '--registry', registry, '--cache', cacheDir, '--loglevel', 'error'], {
    cwd: projectDir,
  });
}

export async function freshCache() {
  const dir = await mkdtemp(path.join(tmpdir(), 'vbench-npm-cache-'));
  return dir;
}

export async function scratchDir(prefix = 'vbench-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(dir, { recursive: true });
  return dir;
}

export function removeDir(dir) {
  return rm(dir, { recursive: true, force: true });
}
