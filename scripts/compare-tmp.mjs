import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';

// Throwaway version comparison: run the benchmark and render a comparison page
// into a single work dir. Nothing is written under results/ and — since only
// report.mjs touches results/history/runs.json — the committed history is never
// modified. Meant to run inside the Docker container (see compare-tmp.sh), where
// --out points at a host temp dir mounted into the container; without --out it
// falls back to an OS temp dir.
//
// Usage: node scripts/compare-tmp.mjs --versions v6=6.0.5,v7=7.0.0-next-7.23 [--out DIR] [--samples 5] [--scenarios publish] [--title "..."]
// All flags are forwarded to bench.mjs; --title is also used for the page.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const args = parseArgs(argv);

function runNode(script, scriptArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...scriptArgs], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))));
  });
}

const workDir =
  typeof args.out === 'string' ? path.resolve(args.out) : await mkdtemp(path.join(tmpdir(), 'vbench-compare-'));
await mkdir(workDir, { recursive: true });

// 1. Benchmark into the temp dir (forward every flag the user passed through).
await runNode('bench.mjs', [...argv, '--out-dir', workDir]);

// 2. Locate the produced result and render a comparison page next to it.
const jsonFile = (await readdir(workDir)).find((f) => f.startsWith('bench-') && f.endsWith('.json'));
if (!jsonFile) throw new Error(`No bench-*.json produced in ${workDir}`);
const inputPath = path.join(workDir, jsonFile);
const outputPath = path.join(workDir, 'compare.html');
const title = typeof args.title === 'string' ? args.title : 'Verdaccio version comparison (temporary)';

await runNode('report-compare.mjs', ['--input', inputPath, '--title', title, '--output', outputPath]);

console.log('\nTemporary comparison ready — nothing committed, runs.json untouched:');
console.log(`  data:   ${inputPath}`);
console.log(`  report: ${outputPath}`);
console.log(`\n  open "${outputPath}"`);
