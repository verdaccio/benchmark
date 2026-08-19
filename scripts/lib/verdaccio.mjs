import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

// Resolve a --versions spec to { version, install } for the target under test.
// A spec ending in .tgz/.tar.gz is treated as a LOCAL TARBALL (an unpublished
// build): it is looked up by path or by filename in <root>/tarballs, its version
// is read from the tarball, and `install` is the tarball path. Everything else is
// a published tag/version resolved via npm. `version` is the identity used as the
// cache-dir name and the label shown in reports; tarballs get a `+tar` suffix so
// they never collide with a published version and are obvious in comparisons.
export async function resolveSpec(spec, root) {
  if (isDockerImage(spec)) {
    const image = spec.slice('docker:'.length);
    const lastSeg = image.split('/').pop();
    const tag = lastSeg.includes(':') ? lastSeg.slice(lastSeg.lastIndexOf(':') + 1) : 'latest';
    return { version: `${tag}+img`, install: null, image };
  }
  if (isTarball(spec)) {
    const tarball = await findTarball(spec, root);
    const version = await readTarballVersion(tarball);
    return { version: `${version}+tar`, install: tarball, image: null };
  }
  const version = await resolveVersion(spec);
  return { version, install: `verdaccio@${version}`, image: null };
}

export function isTarball(spec) {
  return typeof spec === 'string' && /\.(tgz|tar\.gz)$/i.test(spec);
}

// A spec like `docker:verdaccio/verdaccio:nightly-master` benchmarks a published
// Docker image (nightly/master/next-6/…) run as the target container.
export function isDockerImage(spec) {
  return typeof spec === 'string' && spec.startsWith('docker:');
}

// Look for the tarball as given (absolute / cwd-relative), then by filename in
// <root>/tarballs (the folder mounted into the Docker container), then relative
// to the repo root.
async function findTarball(spec, root) {
  const candidates = [path.resolve(spec), path.join(root, 'tarballs', spec), path.join(root, spec)];
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error(`Tarball not found: "${spec}". Put it in tarballs/ and pass the filename, or give a path.`);
}

// Read the version out of an npm tarball (entries live under package/).
async function readTarballVersion(tarball) {
  const { stdout } = await capture('tar', ['-xzO', '-f', tarball, 'package/package.json']);
  return JSON.parse(stdout).version;
}

// Install a specific Verdaccio version once into an isolated prefix and return
// the path to its binary. This removes `npx` resolution cost/variance from every
// server start, so timings reflect Verdaccio itself.
export async function installBinary(version, binRoot, installSpec = `verdaccio@${version}`) {
  const prefix = path.join(binRoot, version);
  const binPath = path.join(prefix, 'node_modules', '.bin', 'verdaccio');
  await mkdir(prefix, { recursive: true });
  const already = await access(binPath)
    .then(() => true)
    .catch(() => false);

  // For a local tarball, reinstall when its contents change (same filename can be
  // rebuilt); a content hash in a marker file drives that. Published versions are
  // immutable, so presence of the binary is enough.
  const tarball = isTarball(installSpec);
  const markerPath = path.join(prefix, '.tarball-sha');
  const wantHash = tarball ? await sha256(installSpec) : null;
  const haveHash = tarball ? await readFile(markerPath, 'utf8').catch(() => null) : null;

  const fresh = already && (!tarball || haveHash === wantHash);
  if (!fresh) {
    await writeFile(path.join(prefix, 'package.json'), JSON.stringify({ private: true }), 'utf8');
    await run('npm', ['install', installSpec, '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: prefix });
    if (tarball) await writeFile(markerPath, wantHash, 'utf8');
  }
  return binPath;
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 16);
}

// A Verdaccio config string. auth + publish/unpublish are always enabled so the
// same config serves read-only install scenarios and the publish/unpublish ones.
// When `offline` is true, no uplink/proxy is configured: the server serves only
// what is already in storage. Used for the frozen upstream snapshot, so metadata
// bytes stay identical over time instead of growing as npm publishes new versions.
export function createConfig({ storageDir, uplinkUrl, offline = false, legacyAuthCache = false, packageFilter = false }) {
  const htpasswdPath = path.join(storageDir, 'htpasswd');
  const proxy = offline ? [] : ['    proxy: npmjs'];
  // @verdaccio/package-filter (7.x/9.x): runs filter_metadata on every packument
  // read, iterating all versions. `packageFilter` may be `true` (no-op, {}) or an
  // options object with real rules (minAgeDays, dateThreshold, excludeDeprecated,
  // block, allow) that force actual per-version work. Versions without the plugin
  // log a "not found" warning and serve unfiltered.
  const filters = filterBlock(packageFilter);
  // server.legacyAuthCache (Verdaccio 7.x/9.x): cache successful legacy Bearer-token
  // validations so bcrypt doesn't re-run on every authenticated request. Off unless
  // requested; ignored by versions that don't support it.
  const lac = legacyAuthCache
    ? [
        'server:',
        '  legacyAuthCache:',
        '    enabled: true',
        `    ttlMs: ${legacyAuthCache.ttlMs ?? 30000}`,
        `    maxEntries: ${legacyAuthCache.maxEntries ?? 1000}`,
      ]
    : [];
  return [
    `storage: ${storageDir}`,
    ...lac,
    ...filters,
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

// Build the `filters:` config block for @verdaccio/package-filter. false → none;
// true → no-op {}; an object → its rules (minAgeDays, dateThreshold, etc.).
function filterBlock(pf) {
  if (!pf) return [];
  const rules = pf === true ? {} : pf;
  const entries = Object.entries(rules).filter(([, v]) => v !== undefined && v !== null && v !== false);
  if (!entries.length) return ['filters:', "  '@verdaccio/package-filter': {}"];
  return [
    'filters:',
    "  '@verdaccio/package-filter':",
    ...entries.map(([k, v]) => `    ${k}: ${typeof v === 'string' ? `'${v}'` : v}`),
  ];
}

// Spawn a prepared Verdaccio binary and resolve once it answers /-/ping.
// `host` defaults to loopback; pass '0.0.0.0' so a Docker-image target container
// can reach this process (as the uplink) via host.docker.internal.
export async function startVerdaccio({ binPath, configPath, port, host = '127.0.0.1' }) {
  const child = spawn(binPath, ['--config', configPath, '--listen', `${host}:${port}`], {
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

// Make a Verdaccio Docker image available up front (so timings don't include the
// download). Local-first: if the image already exists in the daemon — a locally
// built image, or a cached remote tag — use it as-is; otherwise pull it. To
// refresh a cached remote tag, `docker pull` it (or delete the tag) before running.
// Returns 'local' or 'pulled' for logging. Works in docker-out-of-docker too,
// since the CLI talks to the host daemon where local builds live.
export async function ensureImage(image) {
  const localExists = await run('docker', ['image', 'inspect', image]).then(() => true).catch(() => false);
  if (localExists) return 'local';
  await run('docker', ['pull', image]);
  return 'pulled';
}

// The image's repo digest + creation date, so a result records exactly which build
// was measured (mutable tags like nightly-master change over time).
export async function imageInfo(image) {
  const digest = await run('docker', ['image', 'inspect', image, '--format', '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}'])
    .then((o) => o.trim())
    .catch(() => '');
  const created = await run('docker', ['image', 'inspect', image, '--format', '{{.Created}}'])
    .then((o) => o.trim().slice(0, 10))
    .catch(() => '');
  return { digest, created };
}

// Run a published Verdaccio Docker image as the target. Storage is container-
// internal (fresh per `docker run --rm`, so isolation is free); only the generated
// config is bind-mounted read-only and the port is published to the host. The
// caller must have rewritten the config's uplink to reach the host
// (host.docker.internal), and started the upstream on 0.0.0.0.
export async function startVerdaccioImage({ image, configPath, port }) {
  const name = `vbench-target-${port}`;
  await run('docker', ['rm', '-f', name]).catch(() => {});
  await run('docker', [
    'run', '-d', '--rm', '--name', name,
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', `127.0.0.1:${port}:4873`,
    '-v', `${configPath}:/verdaccio/conf/config.yaml:ro`,
    image,
  ]);

  const stop = () => run('docker', ['stop', '-t', '2', name]).then(() => {}).catch(() => {});
  const url = `http://127.0.0.1:${port}/-/ping`;
  const started = performance.now();
  while (performance.now() - started < 60_000) {
    const running = await run('docker', ['inspect', '-f', '{{.State.Running}}', name])
      .then((o) => o.trim() === 'true')
      .catch(() => false);
    if (!running) break;
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (ok) return { registry: `http://127.0.0.1:${port}`, stop };
    await sleep(300);
  }
  const logs = await capture('docker', ['logs', name]).catch(() => ({ stdout: '', stderr: '' }));
  await run('docker', ['rm', '-f', name]).catch(() => {});
  throw new Error(`Verdaccio image ${image} did not become ready on :${port}\n${logs.stderr}${logs.stdout}`);
}

// The harness's own network + IP on it (when running inside a container). Used to
// attach sibling target containers to the same network and to point their uplink
// back at the in-container upstream.
export async function selfDockerNetwork() {
  const self = process.env.HOSTNAME || os.hostname(); // container hostname == its short id
  const out = await run('docker', [
    'inspect', self, '--format', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\\n"}}{{end}}',
  ]);
  const [network, ip] = out.trim().split('\n')[0].trim().split(/\s+/);
  if (!network || !ip) throw new Error(`Could not determine own docker network from:\n${out}`);
  return { network, ip };
}

// Docker-out-of-docker target: launch the image as a SIBLING container on the
// harness's own network (no host port publish). The config can't be bind-mounted
// (host-path semantics), so it is `docker cp`ed in before start. Reached by name.
export async function startVerdaccioImageDood({ image, configPath, name, network }) {
  await run('docker', ['rm', '-f', name]).catch(() => {});
  await run('docker', ['create', '--name', name, '--network', network, image]);
  await run('docker', ['cp', configPath, `${name}:/verdaccio/conf/config.yaml`]);
  await run('docker', ['start', name]);

  const stop = () => run('docker', ['rm', '-f', name]).then(() => {}).catch(() => {});
  const registry = `http://${name}:4873`;
  const started = performance.now();
  while (performance.now() - started < 60_000) {
    const running = await run('docker', ['inspect', '-f', '{{.State.Running}}', name])
      .then((o) => o.trim() === 'true')
      .catch(() => false);
    if (!running) break;
    const ok = await fetch(`${registry}/-/ping`).then((r) => r.ok).catch(() => false);
    if (ok) return { registry, stop };
    await sleep(300);
  }
  const logs = await capture('docker', ['logs', name]).catch(() => ({ stdout: '', stderr: '' }));
  await run('docker', ['rm', '-f', name]).catch(() => {});
  throw new Error(`Verdaccio image ${image} did not become ready (${name})\n${logs.stderr}${logs.stdout}`);
}
