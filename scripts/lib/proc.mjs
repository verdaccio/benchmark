import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// Run a command to completion, capturing output. Rejects with the captured
// output on a non-zero exit so failures are debuggable.
export function run(cmd, args, { cwd, env, stdio = 'pipe' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${cmd} ${args.join(' ')} failed with ${code}\n${output}`));
    });
  });
}

// Run a command and resolve with stdout only (stderr kept separate). Use this
// when parsing structured output: npm writes update notices and warnings to
// stderr, which would otherwise corrupt JSON captured from a merged stream.
export function capture(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} failed with ${code}\n${stderr}${stdout}`));
    });
  });
}

// Time a command's wall-clock duration in milliseconds.
export async function timeCommand(cmd, args, options) {
  const started = performance.now();
  await run(cmd, args, options);
  return performance.now() - started;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
