import {
  buildTestPackage,
  freshCache,
  makeProject,
  publish,
  removeDir,
  timeUnpublish,
  TEST_PACKAGE_NAME,
} from '../lib/npm.mjs';
import { createToken } from '../lib/verdaccio.mjs';

// Unpublish latency: each iteration first publishes a version (untimed prep),
// then measures `npm unpublish <pkg>@<version> --force`. One server (fresh
// storage) is reused across iterations.
export const name = 'unpublish';
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
        // Untimed prep: publish the version we are about to remove.
        await publish({ projectDir, registry: server.registry, cacheDir });

        const ms = await timeUnpublish({
          spec: `${TEST_PACKAGE_NAME}@${version}`,
          registry: server.registry,
          cacheDir,
          projectDir,
        });
        const isWarmup = i < h.warmup;
        if (!isWarmup) samples.push(ms);
        h.log(`  unpublish ${isWarmup ? 'warmup' : `sample ${i - h.warmup + 1}/${h.samples}`}: ${Math.round(ms)}ms`);
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
