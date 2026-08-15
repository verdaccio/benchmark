import { freshCache, makeProject, removeDir, timeInstall } from '../lib/npm.mjs';

// Cold cache-miss through the proxy: every sample gets fresh empty Verdaccio
// storage and a fresh empty npm cache, so the install forces Verdaccio to fetch
// each package from its uplink, persist it, and serve it. This is the path a
// team hits on a first-ever install, and where proxy/store/serve differences
// between versions show up most clearly. The uplink is the warm local upstream,
// so numbers reflect Verdaccio, not npmjs network latency.
export const name = 'proxy-install';
export const unit = 'ms';

export async function run(h) {
  const samples = [];
  const total = h.warmup + h.samples;

  for (let i = 0; i < total; i += 1) {
    const server = await h.startTarget();
    const cacheDir = await freshCache();
    const projectDir = await makeProject({ packageJson: h.fixture, registry: server.registry });
    try {
      const ms = await timeInstall({
        registry: server.registry,
        cacheDir,
        projectDir,
        preferOnline: true,
      });
      const isWarmup = i < h.warmup;
      if (!isWarmup) samples.push(ms);
      h.log(`  proxy-install ${isWarmup ? 'warmup' : `sample ${i - h.warmup + 1}/${h.samples}`}: ${Math.round(ms)}ms`);
    } finally {
      await removeDir(projectDir);
      await removeDir(cacheDir);
      await server.stop();
    }
  }

  return { unit, samples };
}
