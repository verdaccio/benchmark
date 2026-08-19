import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { removeDir } from '../lib/npm.mjs';
import { run as exec, timeCommand } from '../lib/proc.mjs';
import { summarizeSamples } from '../lib/stats.mjs';
import { createToken } from '../lib/verdaccio.mjs';

// Deep publish stress: publish a whole monorepo (N packages, default 400) in one
// shot with `lerna publish from-package`, measuring the total wall-clock per
// release. This exercises the publish path at scale — every package is a fresh,
// authenticated `npm publish` under the hood, so this is where cumulative
// per-request auth cost (bcrypt) and storage churn show up.
//
// With --monorepo-per-package it ALSO runs a second pass each round, publishing
// the N packages one-by-one with `npm publish` (serial, each timed), yielding a
// per-package latency distribution (median/p95/…) in `extra.perPackage` — useful
// to see how a single publish behaves / degrades as the registry fills. lerna
// publishes concurrently, so per-package timing can't be taken from the lerna run
// itself; this dedicated serial pass is the accurate way to get it.
//
// OPT-IN: flagged `optIn` so it is excluded from the default set (see
// scenarios/index.mjs) and never runs in `pnpm bench`. Invoke it explicitly:
//   pnpm docker:bench -- --scenarios monorepo --samples 3 --warmup 1
// Requires `lerna` and `git` on PATH (both baked into the Docker image).
//
// Metric: unit 'ms', one sample = total time to publish all N packages; the
// summary's median is the headline "time per release", and `extra` carries the
// package count, throughput (packages/sec), and (opt) the per-package distribution.
export const name = 'monorepo';
export const unit = 'ms';
export const optIn = true;

const SCOPE = '@verdaccio-bench';
const LERNA_BIN = process.env.LERNA_BIN || 'lerna';
// Identity for the throwaway git repo lerna requires (no global git config in CI/Docker).
const GIT_ID = ['-c', 'user.email=bench@verdaccio.test', '-c', 'user.name=verdaccio-bench'];

export async function run(h) {
  const count = h.monorepoPackages;
  const perPackage = h.monorepoPerPackage;
  const server = await h.startTarget();
  const token = await createToken({
    registry: server.registry,
    username: 'bench',
    password: 'benchpass123',
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'vbench-monorepo-'));
  const samples = [];
  const perPkgTimes = [];

  try {
    await scaffold(dir, server.registry, token, count);

    const total = h.warmup + h.samples;
    for (let i = 0; i < total; i += 1) {
      const isWarmup = i < h.warmup;
      const label = isWarmup ? 'warmup' : `sample ${i - h.warmup + 1}/${h.samples}`;

      // --- lerna: publish all N at a fresh version, timing the whole release ---
      await setVersions(dir, count, `1.0.${i}`);
      await exec('git', [...GIT_ID, 'commit', '-aqm', `round ${i}`], { cwd: dir });
      const ms = await timeCommand(
        LERNA_BIN,
        ['publish', 'from-package', '--yes', '--no-git-reset', '--registry', server.registry, '--loglevel', 'error'],
        { cwd: dir }
      );
      if (!isWarmup) samples.push(ms);
      const perSec = ms > 0 ? count / (ms / 1000) : 0;
      h.log(`  monorepo ${label} (lerna): ${count} pkgs in ${Math.round(ms)}ms (${perSec.toFixed(1)} pkg/s)`);

      // --- per-package: publish each individually with npm, timing each ---
      if (perPackage) {
        const times = await publishPerPackage({ dir, count, version: `1.1.${i}`, registry: server.registry, token });
        if (!isWarmup) perPkgTimes.push(...times);
        const s = summarizeSamples(times);
        h.log(`  monorepo ${label} (per-package): median ${s?.medianMs}ms  p95 ${s?.p95Ms}ms  over ${count} publishes`);
      }
    }
  } finally {
    await server.stop();
    await removeDir(dir);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return {
    unit,
    samples,
    extra: {
      engine: 'lerna',
      packages: count,
      throughputPerSec: medianMs > 0 ? Number((count / (medianMs / 1000)).toFixed(1)) : null,
      perPackage: perPackage ? summarizeSamples(perPkgTimes) : null,
    },
  };
}

// Publish each package one at a time with `npm publish`, returning the per-package
// durations (ms). Serial on purpose so timings don't overlap. Each package gets
// its own .npmrc (npm resolves project config from the package dir, not the root).
async function publishPerPackage({ dir, count, version, registry, token }) {
  const rc = npmrc(registry, token);
  const times = [];
  for (let i = 0; i < count; i += 1) {
    const pkgDir = path.join(dir, 'packages', `pkg-${pad(i)}`);
    await writeFile(path.join(pkgDir, 'package.json'), pkgManifest(i, version));
    await writeFile(path.join(pkgDir, '.npmrc'), rc);
    times.push(
      await timeCommand('npm', ['publish', '--registry', registry, '--no-audit', '--no-fund', '--loglevel', 'error'], {
        cwd: pkgDir,
      })
    );
  }
  return times;
}

// Lay out a lerna monorepo: root manifest + lerna.json + N publishable packages,
// an .npmrc pointing at this Verdaccio (with auth), and an initial git commit
// (lerna refuses to run outside a git repo).
async function scaffold(dir, registry, token, count) {
  await writeFile(
    path.join(dir, 'package.json'),
    json({ name: 'verdaccio-bench-monorepo', version: '0.0.0', private: true, workspaces: ['packages/*'] })
  );
  await writeFile(
    path.join(dir, 'lerna.json'),
    json({ version: 'independent', npmClient: 'npm', packages: ['packages/*'] })
  );
  await writeFile(path.join(dir, '.npmrc'), npmrc(registry, token));
  await writeFile(path.join(dir, '.gitignore'), 'node_modules\n');

  const pkgsDir = path.join(dir, 'packages');
  await mkdir(pkgsDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const pkgDir = path.join(pkgsDir, `pkg-${pad(i)}`);
    await mkdir(pkgDir, { recursive: true });
    // Scaffold at 0.0.0 (never published); round 0 bumps to 1.0.0 so the first
    // round's `git commit` always has a change to record.
    await writeFile(path.join(pkgDir, 'package.json'), pkgManifest(i, '0.0.0'));
    await writeFile(path.join(pkgDir, 'index.js'), `module.exports = ${i};\n`);
  }

  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', [...GIT_ID, 'add', '-A'], { cwd: dir });
  await exec('git', [...GIT_ID, 'commit', '-qm', 'scaffold'], { cwd: dir });
}

async function setVersions(dir, count, version) {
  for (let i = 0; i < count; i += 1) {
    await writeFile(path.join(dir, 'packages', `pkg-${pad(i)}`, 'package.json'), pkgManifest(i, version));
  }
}

function pkgManifest(i, version) {
  return json({
    name: `${SCOPE}/pkg-${pad(i)}`,
    version,
    main: 'index.js',
    publishConfig: { access: 'public' },
  });
}

function npmrc(registry, token) {
  const hostPath = registry.replace(/^https?:/, '').replace(/\/?$/, '/');
  return `registry=${registry}\n${hostPath}:_authToken=${token}\n`;
}

const pad = (i) => String(i).padStart(4, '0');
const json = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
