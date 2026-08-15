import { freshCache, makeProject, removeDir, timeInstall } from '../lib/npm.mjs';

// Steady-state install: Verdaccio storage AND the npm cache are pre-warmed once,
// then each sample installs the fixture into a fresh empty project. Models the
// "everything already fetched" path most CI cache hits take. Verdaccio still
// serves (revalidated) metadata, so version-to-version deltas here reflect its
// warm manifest-serving path.
export const name = 'warm-install';
export const unit = 'ms';

export async function run(h) {
  const server = await h.startTarget();
  const cacheDir = await freshCache();
  const samples = [];

  try {
    // Untimed prime: warms both Verdaccio storage and the npm cache.
    const primeProject = await makeProject({ packageJson: h.fixture, registry: server.registry });
    await timeInstall({ registry: server.registry, cacheDir, projectDir: primeProject });
    await removeDir(primeProject);

    const total = h.warmup + h.samples;
    for (let i = 0; i < total; i += 1) {
      const projectDir = await makeProject({ packageJson: h.fixture, registry: server.registry });
      const ms = await timeInstall({ registry: server.registry, cacheDir, projectDir });
      await removeDir(projectDir);
      const isWarmup = i < h.warmup;
      if (!isWarmup) samples.push(ms);
      h.log(`  warm-install ${isWarmup ? 'warmup' : `sample ${i - h.warmup + 1}/${h.samples}`}: ${Math.round(ms)}ms`);
    }
  } finally {
    await server.stop();
    await removeDir(cacheDir);
  }

  return { unit, samples };
}
