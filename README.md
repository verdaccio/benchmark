# Verdaccio benchmark

Compares Verdaccio behavior across release tags (`latest`, `next-7`, `next-9`) on the
operations that actually matter to a registry: installing, proxying, publishing,
unpublishing, and raw HTTP serving. **npm** is the reference client.

Every run resolves tags to exact versions, installs each Verdaccio version once into an
isolated prefix (so timings measure Verdaccio, not `npx`), records the machine/toolchain
environment, and writes raw + summarized results to `results/`.

## Scenarios

| Scenario         | What it measures                                                                                     | Setup per sample |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| `warm-install`   | Steady-state install. Verdaccio storage **and** the npm cache are pre-warmed; fresh project each run. | reused server, warm cache |
| `proxy-install`  | Cold cache-miss. Empty storage **and** empty npm cache, forcing proxy fetch → store → serve.          | fresh server + fresh cache |
| `publish`        | `npm publish` latency for a small package (new version each sample; auth via a real token).            | reused server |
| `unpublish`      | `npm unpublish --force` latency (the version is published untimed beforehand).                         | reused server |
| `search`         | `npm search` latency against Verdaccio's `/-/v1/search` (storage warmed first). Constant only in `--frozen` mode; in `local` it includes npmjs search round-trips. | reused server |
| `serve`          | Raw HTTP throughput (req/s + latency percentiles) for the packument, abbreviated packument, and a tarball, hit directly with `ab` against pre-warmed storage — bypasses npm entirely. | reused server |

`warm-install` / `proxy-install` are the client-felt install numbers. `serve` is where
version-to-version serving differences show up unmasked by npm's download/extract cost.

## Run

```sh
pnpm bench                       # all 5 scenarios, all 3 versions
pnpm bench:install               # warm-install + proxy-install only
pnpm bench:publish               # publish + unpublish only
pnpm bench:serve                 # serve only
pnpm report                      # render latest results/bench-*.json to reports/*.html
```

### Options

```sh
node scripts/bench.mjs \
  --versions latest=6.9.2,next-7=next-7,next-9=next-9 \  # label=spec; spec is a tag or exact version
  --scenarios warm-install,proxy-install,publish,unpublish,serve \
  --samples 5 \                # measured samples per (scenario, version)
  --warmup 1 \                 # discarded warmup runs before measured samples
  --upstream local \           # 'local' (primed Verdaccio) or 'npmjs' (real network)
  --serve-requests 2000 \      # ab request count per endpoint
  --serve-concurrency 20       # ab concurrency
```

## Docker

A container gives a clean, reproducible environment (Node 24 + `ab`, no host tooling
needed). Outputs are mounted back to the host `results/` and `reports/`, and installed
Verdaccio binaries are cached in a named volume across runs.

Driven entirely through package scripts:

```sh
pnpm docker:build     # build the image (once, or after changing scripts/)
pnpm docker:bench     # run v6=latest, v7=next-7, v9=next-9, v5=latest-5, all scenarios
pnpm docker:report    # render the newest results to reports/*.html
```

Extra flags append to `docker:bench` after `--`:

```sh
pnpm docker:bench -- --samples 10                       # more samples
pnpm docker:bench -- --scenarios serve --serve-requests 5000
pnpm docker:bench -- --versions v6=latest,v9=next-9     # override the version set
```

Under the hood these wrap `docker compose run --rm bench <cmd>`. You can still call it
directly for one-offs (e.g. `docker compose run --rm bench scripts/bench.mjs ...`).
Proxy scenarios reach `registry.npmjs.org` once to prime the local upstream, so the
container needs network on the first run.

## Output

- `results/bench-<timestamp>.json` — env, resolved versions, raw samples, and summary.
- `results/bench-<timestamp>.csv` — flat per-(scenario, version) summary.
- `reports/bench-<timestamp>.html` — side-by-side comparison across versions (via `pnpm report`).

## Constant comparisons over time (frozen upstream)

Pinning fixture versions is **not** enough for comparisons months apart. When Verdaccio
proxies a package it fetches the *full packument* (every version), and that grows every time
npm publishes — e.g. `typescript`'s packument is ~20 MB today and keeps growing. So any
metadata-touching scenario (`serve` info, `proxy-install`, `warm-install` revalidation) drifts
over time due to npm, not Verdaccio. Tarballs are immutable, so tarball serving is unaffected.

The fix is a **frozen snapshot**: prime a Verdaccio from npmjs once, archive its storage, then
run **offline** against that snapshot so every run sees byte-identical metadata.

```sh
pnpm snapshot           # prime once → .cache/upstream-snapshot.tar.gz + a committed manifest
pnpm bench -- --frozen  # or: pnpm bench:frozen — serve the snapshot offline (no npmjs)
```

- Both the tarball and its manifest live under `.cache/` and are **gitignored** — the
  snapshot is a local dataset, not committed. Reused across runs so results stay comparable
  indefinitely on your machine.
- `.cache/upstream-snapshot.manifest.json` records the snapshot's sha256, date, and
  per-package metadata sizes; frozen runs stamp that provenance into their result file.
- To compare on another machine or in CI, share the tarball + manifest out-of-band (e.g. a
  GitHub release asset) and verify the sha256; regenerating from npmjs would produce
  *different* (newer) metadata and defeat the purpose.

Refresh the snapshot deliberately (new fixture, or you *want* current metadata) by re-running
`pnpm snapshot` — that's a conscious baseline change, not silent drift.

## Historical data (2021–2023)

The old Next.js benchmark archive (~2,500 runs, Jun 2021 – Apr 2023) is rescued into
`results/history/` and rendered as a trend report:

```sh
pnpm import:history   # walk the old repo → results/history/history.{json,csv}
pnpm report:history   # → reports/archive.html (deep per-version trend, era-separated)
```

`import:history` reads the old repo (default `/Users/verdaccio/projects/verdaccio-benchmark`,
override with `--src`); the normalized `history.json`/`history.csv` are committed so the data
survives independently of that app. Two things to know when reading it:

- It only covers the **serve** family (packument `info` + `tarball`).
- The archive **changed methodology** partway through — early runs timed npm CLI ops
  (`npm info`/`npm install jquery`, seconds), later runs timed raw HTTP (`curl`, ms). Each
  record carries its `method`, and the report keeps the two eras in separate sections. They
  are not comparable to each other, nor to today's runs (different machine and package).

## Dashboard & progress over time

`pnpm report` does two things: writes `reports/bench-<timestamp>.html` for that run, and
appends a compact summary to the committed `results/history/runs.json`. `pnpm build:site`
turns those into a **dashboard** (`_site/index.html`):

- **Runs by date** — every recorded run, newest first, linking to its full report.
- **Progress over time** — one chart per scenario, median per Verdaccio major across run
  dates. The serve chart is seeded with the 2021–2023 archive (hollow points, dashed line);
  since that came from a different machine, treat the archive→now step as directional.

The raw `bench-*.json` stay gitignored; only the small `runs.json` digest is committed, so
progress accumulates as you add runs without bloating the repo.

## Publishing to GitHub Pages

On every push to `main` that changes a report, `.github/workflows/pages.yml` builds the site
(`build-site.mjs`) and deploys it — `index.html` is the dashboard, individual run reports and
the `archive.html` deep-dive are linked from it.

The workflow deliberately does **not** run the benchmark — shared CI runners are too noisy
for trustworthy timings. The intended flow is:

```sh
pnpm bench            # (or pnpm docker:bench) on a controlled machine
pnpm report           # writes reports/bench-<timestamp>.html + updates runs.json
git add reports/bench-*.html results/history/runs.json && git commit && git push   # CI deploys
```

One-time setup: in the repo's **Settings → Pages**, set **Source: GitHub Actions**. (The
default branch here is `main`; if your remote uses `master`, change `branches:` in the
workflow.) Reports are self-contained HTML, so nothing external is fetched at view time.

## Methodology notes

1. **Reproducibility:** tags are resolved to exact versions at run start and stamped into
   every result file, alongside node/npm/OS/CPU. Results are only comparable within one
   environment snapshot — never across machines.
2. **Verdaccio, not `npx`:** each version is installed once into `.cache/bin/<version>` and
   spawned directly, removing `npx` resolution variance from server startup.
3. **Local upstream by default:** proxy scenarios uplink to a local Verdaccio primed with the
   fixture dependencies, so numbers reflect Verdaccio's proxy path rather than npmjs network
   latency. Use `--upstream npmjs` to deliberately include real network behavior.
4. **Warmup:** the first run per scenario warms OS disk cache and is discarded (`--warmup`).
5. **Isolation:** each sample uses fresh temp project dirs and free OS-assigned ports, so a
   leaked process from a previous run can't collide.

## Layout

```
scripts/
  bench.mjs              orchestrator: resolve → install → run scenarios → write results
  report.mjs             render results JSON to an HTML comparison
  lib/                   shared helpers (args, proc, net, npm, stats, env, ab, verdaccio)
  scenarios/             one module per scenario ({ name, unit, run })
fixtures/install-mixed/  the package.json installed by the install scenarios
```

The older single-purpose runners (`bench-install.mjs`, `bench-hyperfine-warm.mjs`,
`report-hyperfine.mjs`) remain available as `pnpm bench:legacy` / `bench:hyperfine` /
`report:hyperfine`.
