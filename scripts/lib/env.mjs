import os from 'node:os';
import { capture } from './proc.mjs';

// Capture the machine + toolchain context so results are interpretable later.
// Results are only comparable within one env snapshot.
export async function captureEnv() {
  const cpus = os.cpus();
  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    npm: await tryVersion('npm'),
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    },
    cpu: {
      model: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
    },
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  };
}

async function tryVersion(cmd) {
  return capture(cmd, ['--version'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => 'unknown');
}
