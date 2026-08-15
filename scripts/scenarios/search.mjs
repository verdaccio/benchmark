import { freshCache, makeProject, removeDir, timeInstall } from '../lib/npm.mjs';
import { timeCommand } from '../lib/proc.mjs';

// `npm search` latency: hits Verdaccio's /-/v1/search endpoint. Storage is warmed
// first (fixture installed) so there is something indexed to match. One server is
// reused; each sample times a search for a term present in the fixture.
export const name = 'search';
export const unit = 'ms';

const QUERY = 'lodash';

export async function run(h) {
  const server = await h.startTarget();
  const cacheDir = await freshCache();
  const samples = [];

  try {
    // Untimed warm: populate + index the fixture packages so search has matches.
    const prime = await makeProject({ packageJson: h.fixture, registry: server.registry });
    await timeInstall({ registry: server.registry, cacheDir, projectDir: prime });
    await removeDir(prime);

    // A cwd with the registry set, so `npm search` targets this Verdaccio.
    const ctx = await makeProject({
      packageJson: { name: 'search-ctx', version: '0.0.0', private: true },
      registry: server.registry,
    });

    const total = h.warmup + h.samples;
    for (let i = 0; i < total; i += 1) {
      const ms = await timeCommand(
        'npm',
        ['search', QUERY, '--registry', server.registry, '--no-audit', '--no-fund', '--loglevel', 'error'],
        { cwd: ctx }
      );
      const isWarmup = i < h.warmup;
      if (!isWarmup) samples.push(ms);
      h.log(`  search ${isWarmup ? 'warmup' : `sample ${i - h.warmup + 1}/${h.samples}`}: ${Math.round(ms)}ms`);
    }
    await removeDir(ctx);
  } finally {
    await server.stop();
    await removeDir(cacheDir);
  }

  return { unit, samples };
}
