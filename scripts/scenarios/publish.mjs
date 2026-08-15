import { buildTestPackage, makeProject, removeDir, timePublish, freshCache } from '../lib/npm.mjs';
import { createToken } from '../lib/verdaccio.mjs';

// Publish throughput: how long `npm publish` takes against each Verdaccio
// version. One server (fresh storage) is reused; each iteration publishes a new
// version of a small synthetic package (npm refuses to republish a version).
// Project prep + auth are untimed; only `npm publish` is measured.
export const name = 'publish';
export const unit = 'ms';

export async function run(h) {
  const server = await h.startTarget();
  const cacheDir = await freshCache();
  const token = await createToken({
    registry: server.registry,
    username: 'bench',
    password: 'benchpass123',
  });
  const samples = [];

  try {
    const total = h.warmup + h.samples;
    for (let i = 0; i < total; i += 1) {
      const version = `1.0.${i}`;
      const { packageJson, files } = buildTestPackage(version);
      const projectDir = await makeProject({
        packageJson,
        registry: server.registry,
        authToken: token,
        files,
      });
      try {
        const ms = await timePublish({ projectDir, registry: server.registry, cacheDir });
        const isWarmup = i < h.warmup;
        if (!isWarmup) samples.push(ms);
        h.log(`  publish ${isWarmup ? 'warmup' : `sample ${i - h.warmup + 1}/${h.samples}`}: ${Math.round(ms)}ms`);
      } finally {
        await removeDir(projectDir);
      }
    }
  } finally {
    await server.stop();
    await removeDir(cacheDir);
  }

  return { unit, samples };
}
