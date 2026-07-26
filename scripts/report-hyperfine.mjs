import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(root, 'results');
const reportsDir = path.join(root, 'reports');
const args = parseArgs(process.argv.slice(2));

const inputPath = args.input ? path.resolve(args.input) : await latestHyperfineJson();
const data = JSON.parse(await readFile(inputPath, 'utf8'));
const generatedAt = new Date();
const rows = data.results.map((result) => {
  const sorted = [...result.times].sort((a, b) => a - b);
  return {
    command: result.command,
    samples: result.times.length,
    mean: result.mean,
    median: result.median,
    stddev: result.stddev,
    min: result.min,
    max: result.max,
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
});

const outputPath = args.output
  ? path.resolve(args.output)
  : path.join(reportsDir, `${path.basename(inputPath, '.json')}.html`);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderHtml({ rows, inputPath, generatedAt }), 'utf8');
console.log(outputPath);

async function latestHyperfineJson() {
  const files = await readdir(resultsDir);
  const candidates = files
    .filter((file) => file.startsWith('hyperfine-warm-') && file.endsWith('.json'))
    .sort()
    .reverse();

  if (candidates.length === 0) {
    throw new Error(`No hyperfine result JSON found in ${resultsDir}`);
  }

  return path.join(resultsDir, candidates[0]);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    parsed[key] = inlineValue ?? argv[i + 1];
    if (inlineValue === undefined) i += 1;
  }
  return parsed;
}

function percentile(sortedValues, p) {
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function renderHtml({ rows, inputPath, generatedAt }) {
  const fastestMedian = Math.min(...rows.map((row) => row.median));
  const fastestP95 = Math.min(...rows.map((row) => row.p95));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verdaccio install benchmark</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f4;
      --text: #1f2933;
      --muted: #5b6673;
      --line: #d7dcca;
      --accent: #0f766e;
      --accent-2: #7c3aed;
      --panel: #ffffff;
    }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    main {
      width: min(1040px, calc(100% - 32px));
      margin: 40px auto;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 32px;
      line-height: 1.15;
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      margin-bottom: 28px;
      line-height: 1.5;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
    }
    th, td {
      padding: 12px 14px;
      text-align: right;
      border-bottom: 1px solid var(--line);
      white-space: nowrap;
    }
    th:first-child, td:first-child {
      text-align: left;
    }
    th {
      font-size: 13px;
      color: var(--muted);
      background: #eef1e8;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .best {
      color: var(--accent);
      font-weight: 700;
    }
    .bars {
      display: grid;
      gap: 14px;
      margin-top: 28px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 160px 1fr 80px;
      gap: 14px;
      align-items: center;
    }
    .track {
      height: 14px;
      background: #e6eadc;
      border: 1px solid var(--line);
    }
    .fill {
      height: 100%;
      background: var(--accent-2);
    }
    .note {
      margin-top: 24px;
      color: var(--muted);
      line-height: 1.5;
    }
    code {
      background: #eef1e8;
      padding: 2px 5px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Verdaccio install benchmark</h1>
    <div class="meta">
      Generated ${escapeHtml(generatedAt.toISOString())}<br>
      Source: <code>${escapeHtml(path.relative(root, inputPath))}</code><br>
      Scenario: warm <code>npm install</code> through Verdaccio with local cached upstream. Rows labeled <code>npmjs direct</code> use the public npm registry and include network behavior.
    </div>

    <table>
      <thead>
        <tr>
          <th>Command</th>
          <th>Samples</th>
          <th>Mean</th>
          <th>Median</th>
          <th>p90</th>
          <th>p95</th>
          <th>p99</th>
          <th>Min</th>
          <th>Max</th>
          <th>Stddev</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
        <tr>
          <td>${escapeHtml(row.command)}</td>
          <td>${row.samples}</td>
          <td>${seconds(row.mean)}</td>
          <td class="${row.median === fastestMedian ? 'best' : ''}">${seconds(row.median)}</td>
          <td>${seconds(row.p90)}</td>
          <td class="${row.p95 === fastestP95 ? 'best' : ''}">${seconds(row.p95)}</td>
          <td>${seconds(row.p99)}</td>
          <td>${seconds(row.min)}</td>
          <td>${seconds(row.max)}</td>
          <td>${seconds(row.stddev)}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <div class="bars">
      ${rows.map((row) => `
      <div class="bar-row">
        <div>${escapeHtml(row.command)}</div>
        <div class="track"><div class="fill" style="width: ${Math.round((row.p95 / Math.max(...rows.map((item) => item.p95))) * 100)}%"></div></div>
        <div>${seconds(row.p95)}</div>
      </div>`).join('')}
    </div>

    <p class="note">Lower is better. Best median and p95 are highlighted. Percentiles use nearest-rank over the raw hyperfine samples.</p>
  </main>
</body>
</html>
`;
}

function seconds(value) {
  return `${value.toFixed(3)}s`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
