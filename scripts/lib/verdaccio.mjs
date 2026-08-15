import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { capture, run, sleep } from './proc.mjs';

// Resolve an npm dist-tag or range (e.g. "next-7") to an exact version so
// results stay reproducible even after the tag moves.
export async function resolveVersion(spec) {
  const { stdout } = await capture('npm', ['view', `verdaccio@${spec}`, 'version', '--json']);
  const parsed = JSON.parse(stdout.trim());
  // `npm view` returns a string for one match, an array when the range spans
  // multiple published versions; take the highest in that case.
  return Array.isArray(parsed) ? parsed.at(-1) : parsed;
}

// Install a specific Verdaccio version once into an isolated prefix and return
// the path to its binary. This removes `npx` resolution cost/variance from every
// server start, so timings reflect Verdaccio itself.
export async function installBinary(version, binRoot) {
  const prefix = path.join(binRoot, version);
  const binPath = path.join(prefix, 'node_modules', '.bin', 'verdaccio');
  await mkdir(prefix, { recursive: true });
  // Idempotent: skip the install if the binary is already present.
  const already = await access(binPath)
    .then(() => true)
    .catch(() => false);
  if (!already) {
    await writeFile(path.join(prefix, 'package.json'), JSON.stringify({ private: true }), 'utf8');
    await run('npm', ['install', `verdaccio@${version}`, '--no-audit', '--no-fund', '--loglevel', 'error'], {
      cwd: prefix,
    });
  }
  return binPath;
}

// A Verdaccio config string. auth + publish/unpublish are always enabled so the
// same config serves read-only install scenarios and the publish/unpublish ones.
// When `offline` is true, no uplink/proxy is configured: the server serves only
// what is already in storage. Used for the frozen upstream snapshot, so metadata
// bytes stay identical over time instead of growing as npm publishes new versions.
export function createConfig({ storageDir, uplinkUrl, offline = false }) {
  const htpasswdPath = path.join(storageDir, 'htpasswd');
  const proxy = offline ? [] : ['    proxy: npmjs'];
  return [
    `storage: ${storageDir}`,
    'auth:',
    '  htpasswd:',
    `    file: ${htpasswdPath}`,
    '    max_users: 1000',
    ...(offline
      ? []
      : ['uplinks:', '  npmjs:', `    url: ${uplinkUrl}`, '    max_fails: 10', '    timeout: 60s']),
    'packages:',
    "  '@*/*':",
    '    access: $all',
    '    publish: $authenticated',
    '    unpublish: $authenticated',
    ...proxy,
    "  '**':",
    '    access: $all',
    '    publish: $authenticated',
    '    unpublish: $authenticated',
    ...proxy,
    'logs:',
    '  - {type: stdout, format: pretty, level: error}',
    '',
  ].join('\n');
}

// Spawn a prepared Verdaccio binary and resolve once it answers /-/ping.
export async function startVerdaccio({ binPath, configPath, port }) {
  const child = spawn(binPath, ['--config', configPath, '--listen', `127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Resolves when the process fully exits, however it exits (code or signal).
  const exited = new Promise((resolve) => child.once('exit', resolve));

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  await waitForHttp(`http://127.0.0.1:${port}/-/ping`, 60_000, () => output, child);

  return {
    child,
    registry: `http://127.0.0.1:${port}`,
    stop: () => stopServer(child, exited),
  };
}

// Terminate and wait for the process to actually go away. Verdaccio exits on
// SIGTERM via signal (leaving child.exitCode null), so we await the exit event
// rather than poll exitCode, and escalate to SIGKILL if it lingers.
export async function stopServer(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = sleep(5000).then(() => 'timeout');
  const result = await Promise.race([exited.then(() => 'exited'), timer]);
  if (result === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitForHttp(url, timeoutMs, getOutput, child) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Verdaccio exited with ${child.exitCode}\n${getOutput()}`);
    }
    const ok = await fetch(url)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`Verdaccio did not start within ${timeoutMs}ms\n${getOutput()}`);
}

// Create (or log in) a user via the couchdb-compatible endpoint and return a
// bearer token, so npm publish/unpublish can authenticate non-interactively.
export async function createToken({ registry, username, password }) {
  const response = await fetch(`${registry}/-/user/org.couchdb.user:${username}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: username,
      password,
      email: `${username}@bench.local`,
      type: 'user',
      roles: [],
      date: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Token request failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json();
  if (!body.token) throw new Error(`No token in response: ${JSON.stringify(body)}`);
  return body.token;
}
