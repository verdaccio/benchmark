import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { getFreePort } from './lib/net.mjs';
import { makeProject, removeDir, scratchDir, timeInstall } from './lib/npm.mjs';
import { run } from './lib/proc.mjs';
import { createConfig, installBinary, resolveVersion, startVerdaccio } from './lib/verdaccio.mjs';

// Build a FROZEN upstream snapshot: prime a Verdaccio from npmjs with the fixture
// deps (full packuments + tarballs as they are today), then archive that storage.
// Benchmarks run offline against this snapshot so metadata bytes never change —
// otherwise packuments grow every time npm publishes and slowly skew every
// metadata-touching scenario. A small manifest is committed for traceability;
// the (large) tarball is gitignored under .cache/ and shared out-of-band.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'fixtures', 'install-mixed');
const binRoot = path.join(root, '.cache', 'bin');
const snapshotTar = path.join(root, '.cache', 'upstream-snapshot.tar.gz');
const manifestPath = path.join(root, '.cache', 'upstream-snapshot.manifest.json');

const args = parseArgs(process.argv.slice(2));
const spec = args['upstream-spec'] ?? 'latest';

// Idempotent: reuse an existing snapshot unless --force. Lets scripts call this
// safely before every frozen run without re-priming from npmjs each time.
if (!args.force && (await access(snapshotTar).then(() => true).catch(() => false))) {
  console.log(`Snapshot already exists: ${path.relative(root, snapshotTar)} (use --force to rebuild).`);
  process.exit(0);
}

const version = await resolveVersion(spec);
console.log(`Priming a frozen snapshot with verdaccio@${version} ...`);
const binPath = await installBinary(version, binRoot);

const work = await scratchDir('vbench-snapshot-');
const storageDir = path.join(work, 'storage');
await mkdir(storageDir, { recursive: true });
const configPath = path.join(work, 'config.yaml');
await writeFile(configPath, createConfig({ storageDir, uplinkUrl: 'https://registry.npmjs.org/' }), 'utf8');

const port = await getFreePort();
const server = await startVerdaccio({ binPath, configPath, port });

const fixtureRaw = await readFile(path.join(fixtureDir, 'package.json'), 'utf8');
const fixture = JSON.parse(fixtureRaw);
const cacheDir = await scratchDir('vbench-snapshot-cache-');
const projectDir = await makeProject({ packageJson: fixture, registry: server.registry });

try {
  console.log('Installing fixture to populate storage (full packuments + tarballs) ...');
  await timeInstall({ registry: server.registry, cacheDir, projectDir, preferOnline: true });
} finally {
  await server.stop();
}

console.log('Archiving storage ...');
await run('tar', ['-czf', snapshotTar, '-C', storageDir, '.']);

// Manifest: hash of the tar + per-package metadata sizes/version counts, so you
// can verify a snapshot and see exactly what was frozen and when.
const tarBuf = await readFile(snapshotTar);
const sha256 = createHash('sha256').update(tarBuf).digest('hex');
const packages = await packumentStats(storageDir);
const manifest = {
  createdAt: new Date().toISOString(),
  verdaccioVersion: version,
  fixtureSha256: createHash('sha256').update(fixtureRaw).digest('hex'),
  fixtureDependencies: fixture.dependencies ?? {},
  snapshot: { file: path.relative(root, snapshotTar), sha256, bytes: tarBuf.length },
  totalPackumentBytes: packages.reduce((sum, p) => sum + p.packumentBytes, 0),
  packages,
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

await removeDir(projectDir);
await removeDir(cacheDir);
await removeDir(work);

console.log(`\nSnapshot: ${path.relative(root, snapshotTar)} (${mb(tarBuf.length)} MB, sha256 ${sha256.slice(0, 12)}…)`);
console.log(`Manifest: ${path.relative(root, manifestPath)} (${packages.length} packages, ${mb(manifest.totalPackumentBytes)} MB metadata)`);
console.log('Run frozen benchmarks with:  pnpm bench -- --frozen');

// Walk storage collecting each package's packument size + version count.
async function packumentStats(dir) {
  const out = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'package.json') {
        const raw = await readFile(full, 'utf8').catch(() => null);
        if (!raw) continue;
        let versions = null;
        try {
          versions = Object.keys(JSON.parse(raw).versions ?? {}).length;
        } catch {}
        out.push({ name: path.relative(dir, path.dirname(full)), packumentBytes: (await stat(full)).size, versions });
      }
    }
  };
  await walk(dir);
  return out.sort((a, b) => b.packumentBytes - a.packumentBytes);
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}
