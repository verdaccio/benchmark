# Benchmark reference

Everything about **what the benchmark runs and how**: scenarios, commands, options, Docker,
frozen snapshots, comparison pages, output, methodology, and layout. For a high-level
overview see [README.md](README.md).

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

### Monorepo (deep publish, opt-in)

`monorepo` is a heavy, **opt-in** scenario that publishes a whole monorepo — N packages
(default **400**) — in one release with `lerna publish from-package`, measuring the total
wall-clock per release. It stresses the publish path at scale: every package is a fresh,
authenticated `npm publish`, so this is where cumulative per-request auth cost and storage
churn surface.

It is flagged `optIn` in `scenarios/index.mjs`, so it is **excluded from the default set** and
never runs in `pnpm bench` / `pnpm docker:bench`. Run it explicitly (needs `lerna` + `git`,
both baked into the Docker image):

```sh
pnpm docker:bench:monorepo                                   # v6=latest, 400 packages, samples 3 + 1 warmup
pnpm docker:bench:monorepo -- --versions v6=6.1.6            # pick the version to test
pnpm docker:bench:monorepo -- --versions v6=6.0.5,v7=next-7  # compare versions (one release each)
pnpm docker:bench -- --scenarios monorepo --monorepo-packages 100 --samples 2 --warmup 1
```

- `--versions label=spec,…` — like every scenario, choose which Verdaccio version(s) to test;
  it runs a full release per version. The dedicated script defaults to a single version
  (`v6=latest`) because each run is heavy; override to compare.
- `--monorepo-packages N` — how many packages to publish per release (default 400).
- `--monorepo-per-package` — also run a second pass each round publishing the N packages
  one-by-one with `npm publish` (serial, each timed), adding a per-package latency
  distribution (median/p95/min/max) to the result's `extra.perPackage`. lerna publishes
  concurrently so per-package timing can't come from the lerna run itself; this dedicated
  serial pass is the accurate source. Doubles the publishes per round — use a small N.
- One sample = one full release of all N packages; the summary median is the headline time,
  and the result's `extra` carries the package count + throughput (packages/sec, also logged
  live per round). Keep `--samples` low — each sample republishes all N packages.

```sh
pnpm docker:bench:monorepo -- --versions v6=6.1.6 --monorepo-packages 50 --monorepo-per-package
# → lerna total + throughput, plus per-package median/p95 over the 50 publishes
```

**HTML report.** Render a version comparison page (same style as `report:compare`) from a
monorepo run — release time + throughput, and the per-package distribution when present:

```sh
pnpm docker:bench:monorepo -- --versions v605=6.0.5,v616=6.1.6 --monorepo-packages 50 --monorepo-per-package
pnpm report:monorepo        # newest run → reports/monorepo.html (or --input/--output/--title)
```

## Full suite across 5.x / 6.x / 7.x / master

`pnpm bench:all` (`scripts/bench-all.sh`) runs the whole suite — core scenarios,
monorepo, and large-packument (`bigpkg`) — across the latest **5.x** (npm `latest-5`),
**6.x**/**7.x** (Docker `6.x-next`/`7.x-next`) and **master** (`nightly-master`), then
builds the dashboard. It pulls the fresh published images first. Heavy (~30-60 min);
raw results in `results/` (gitignored), pinned pages `reports/compare-all.html`,
`reports/monorepo.html`, `reports/bigpkg.html`, and the dashboard in `_site/`.

```sh
pnpm bench:all           # default samples (10 core; monorepo/bigpkg tuned)
pnpm bench:all 5         # fewer samples for a quicker pass
```

## Docker (recommended)

A container gives a clean, reproducible environment (Node 24 + `ab`, no host tooling
needed). Outputs are mounted back to the host `results/` and `reports/`, and installed
Verdaccio binaries are cached in a named volume across runs.

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

### Throwaway comparison (`bench:compare`)

Compare versions without leaving any trace: runs the whole flow **inside Docker** and writes
the result + comparison page to a host temp dir — nothing lands in `results/`, `reports/`, or
`results/history/runs.json`.

```sh
pnpm bench:compare -- --versions v6=6.0.5,v7=7.0.0-next-7.23 --scenarios publish --samples 5
```

It builds the image, mounts a fresh temp dir into the container, runs the benchmark there,
and prints an `open "…/compare.html"` line at the end. Accepts every `bench.mjs` flag plus
`--title` for the page heading.

## Package scripts

```sh
pnpm bench                       # all 6 scenarios, all 3 versions
pnpm bench:install               # warm-install + proxy-install only
pnpm bench:publish               # publish + unpublish only
pnpm bench:serve                 # serve only
pnpm bench:frozen                # all scenarios against the frozen snapshot (offline)
pnpm report                      # render latest results/bench-*.json to reports/*.html
```

### Options

```sh
node scripts/bench.mjs \
  --versions latest=6.9.2,next-7=next-7,next-9=next-9 \  # label=spec; spec is a tag or exact version
  --scenarios warm-install,proxy-install,publish,unpublish,search,serve \
  --samples 5 \                # measured samples per (scenario, version)
  --warmup 1 \                 # discarded warmup runs before measured samples
  --upstream local \           # 'local' (primed Verdaccio) or 'npmjs' (real network)
  --frozen \                   # serve the frozen snapshot offline (see below)
  --out-dir /tmp/x \           # write results somewhere other than results/
  --legacy-auth-cache \        # enable server.legacyAuthCache on the target (7.x/9.x)
  --serve-requests 2000 \      # ab request count per endpoint
  --serve-concurrency 20       # ab concurrency
```

## Auth cache (`--legacy-auth-cache`)

Verdaccio 7.x/9.x added `server.legacyAuthCache`, which caches successful legacy
(Bearer) auth-token validations so **bcrypt doesn't re-run on every authenticated
request** — the dominant cost of `publish`/`unpublish`/`monorepo` since 6.1. Pass
`--legacy-auth-cache` to enable it on the target (optionally `--legacy-auth-cache-ttl
<ms>`, default 30000). It applies to every benchmark type and both binary and Docker
targets; versions that don't support the key ignore it.

```sh
# enable it for all targets
pnpm docker:bench -- --scenarios publish --versions m=docker:verdaccio/verdaccio:nightly-master --samples 5 --legacy-auth-cache
```

**Compare off vs on in one run** — `--legacy-auth-cache-compare` runs EACH version twice
(cache off + on), labeled `<v>` and `<v>+cache`, so a single report shows them side by side:

```sh
pnpm docker:bench -- --scenarios publish \
  --versions v7=docker:verdaccio/verdaccio:7.x-next,m=docker:verdaccio/verdaccio:nightly-master \
  --samples 5 --legacy-auth-cache-compare
pnpm report:compare        # rows: v7, v7+cache, m, m+cache
```

Measured effect (nightly-master, publish): median ~477ms → ~291ms with the cache on
— back near pre-bcrypt (`crypt`) levels. The setting is stamped into the result
JSON (`settings.legacyAuthCache`).

## Local tarballs (unpublished builds)

To benchmark a Verdaccio build that isn't on npm, drop its `.tgz` into `tarballs/`
(mounted into the container at `/app/tarballs`) and reference it by filename in
`--versions` — any spec ending in `.tgz`/`.tar.gz` is treated as a local tarball:

```sh
# in a verdaccio checkout: `npm pack`  →  copy the .tgz into tarballs/
pnpm docker:bench -- --versions v9=next-9,local=verdaccio-9.0.0-next.tgz --samples 5
pnpm docker:bench:monorepo -- --versions local=verdaccio-9.0.0-next.tgz --monorepo-packages 100
pnpm bench:compare -- --versions v9=next-9,local=verdaccio-9.0.0-next.tgz --scenarios publish
```

- Works across **every** benchmark type (bench, monorepo, compare) — they all
  resolve versions through the same path (`resolveSpec` → `installBinary`).
- Its identity in results/reports is the tarball's own version + a `+tar` suffix
  (e.g. `9.0.0-next-9.25+tar`), so it never collides with a published version.
- Rebuilding a same-named tarball re-installs automatically when its contents
  change (a content hash is tracked). Tarballs are gitignored; see `tarballs/README.md`.

## Docker-image targets (nightly / master / next-6 / next-7 …)

Benchmark a published Verdaccio **Docker image** run as the target container. Prefix
the spec with `docker:` and give the image ref; any published tag works:

```sh
# IMPORTANT: run the harness NATIVELY (it launches `docker run` for the target),
# NOT inside the bench container. So use `pnpm bench` / node directly, not docker:bench.
node scripts/bench.mjs --scenarios publish \
  --versions v9=next-9,master=docker:verdaccio/verdaccio:nightly-master --samples 5
node scripts/bench.mjs --scenarios monorepo --monorepo-packages 100 \
  --versions n6=docker:verdaccio/verdaccio:6-next,n7=docker:verdaccio/verdaccio:next-7
node scripts/report-compare.mjs   # or report-monorepo — render as usual
```

Local images work too — build one from a Verdaccio checkout and reference it by tag:

```sh
# in a verdaccio checkout: docker build -t verdaccio-local:dev .
node scripts/bench.mjs --scenarios publish --versions dev=docker:verdaccio-local:dev --samples 5
```

Image resolution is **local-first**: if the tag already exists in the daemon (a local
build, or a cached remote tag) it is used as-is; otherwise it is pulled. To refresh a
cached remote tag, `docker pull` it (or delete the tag) before running.

How it works:
- The image is made available (local or pulled), then each target is a `docker run --rm` container:
  storage is container-internal (fresh per run = free isolation), only the generated
  config is bind-mounted read-only, and the port is published to `127.0.0.1`.
- The uplink is auto-rewritten to `host.docker.internal` and the local/frozen upstream
  is bound to `0.0.0.0`, so the container can proxy to the host-side upstream.
- Identity in results/reports is `<tag>+img` (e.g. `nightly-master+img`), never colliding
  with an npm version. Works in every benchmark type (bench, monorepo, compare).

Runs both ways:
- **Native harness** (`pnpm bench` / `node scripts/bench.mjs`): the target's port is published
  to `127.0.0.1` and its uplink uses `host.docker.internal`.
- **Containerized harness** (`pnpm docker:bench` / `docker compose run`): docker-out-of-docker —
  the bench container mounts the host Docker socket (see `docker-compose.yml`) and the Docker CLI
  is baked into the image, so it launches the target as a **sibling** container on its own network
  (reached by name; uplink points at the bench container's IP). `VBENCH_IN_CONTAINER=1` selects
  this mode automatically. So `docker:<image>` works through the containerized entry points too.

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

## Version comparison pages

A dedicated head-to-head page for one release line (e.g. the whole v6 line), separate from
the time-series dashboard. It runs a **frozen** Docker sweep across the given versions —
all default scenarios, including `search` — and renders a page ordered by semver with the
newest as baseline and % deltas. Unlike `bench:compare`, this one is meant to be committed.

```sh
pnpm compare:v6     # sweeps 6.0.5→6.9.2 (one per minor) in Docker, writes reports/compare-v6.html
```

For another line, call the generic script directly:

```sh
scripts/compare-line.sh v9 9.0.0-next-9.20,9.0.0-next-9.24 15
scripts/compare-line.sh v6 6.0.0,6.0.1,6.0.2,…,6.9.2 10   # patch-level: pass all 40, fewer samples
```

The script builds the image, ensures the frozen snapshot exists (skipped if present),
benchmarks in the container, and generates + links the page. Review it (`open _site/index.html`),
then commit `reports/compare-<label>.html` to pin it as the official comparison.

## Output, dashboard & publishing

Per-run outputs:

- `results/bench-<timestamp>.json` — env, resolved versions, raw samples, and summary.
- `results/bench-<timestamp>.csv` — flat per-(scenario, version) summary.
- `reports/bench-<timestamp>.html` — side-by-side comparison across versions (via `pnpm report`).

`pnpm report` does two things: writes `reports/bench-<timestamp>.html` for that run, and
appends a compact summary to the committed `results/history/runs.json`. `pnpm build:site`
turns those into a **dashboard** (`_site/index.html`):

- **Runs by date** — every recorded run, newest first, linking to its full report.
- **Progress over time** — one chart per scenario, median per Verdaccio major across run
  dates. The serve chart is seeded with the 2021–2023 archive (hollow points, dashed line);
  since that came from a different machine, treat the archive→now step as directional.

The raw `bench-*.json` stay gitignored; only the small `runs.json` digest is committed, so
progress accumulates as you add runs without bloating the repo.

On every push to `main` that changes a report, `.github/workflows/pages.yml` builds the site
(`build-site.mjs`) and deploys it. The workflow deliberately does **not** run the benchmark —
shared CI runners are too noisy for trustworthy timings. The intended flow is:

```sh
pnpm docker:bench     # (or pnpm bench) on a controlled machine
pnpm report           # writes reports/bench-<timestamp>.html + updates runs.json
git add reports/bench-*.html results/history/runs.json && git commit && git push   # CI deploys
```

One-time setup: in the repo's **Settings → Pages**, set **Source: GitHub Actions**. Reports
are self-contained HTML, so nothing external is fetched at view time.

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
  report.mjs             render one run's results JSON to an HTML report
  report-compare.mjs     version-comparison page from one run
  report-monorepo.mjs    monorepo-publish comparison page (release time + per-package)
  report-history.mjs     deep 2021–2023 archive view
  import-history.mjs     rescue the old archive into results/history
  snapshot-upstream.mjs  build the frozen upstream snapshot
  build-site.mjs         assemble the dashboard + site
  compare-line.sh        one-command Docker comparison sweep (committed page)
  compare-tmp.sh         Docker launcher for the throwaway comparison (bench:compare)
  compare-tmp.mjs        in-container orchestrator for the throwaway comparison
  lib/                   shared helpers (args, proc, net, npm, stats, env, ab, runs, verdaccio)
  scenarios/             one module per scenario ({ name, unit, run })
fixtures/install-mixed/  the package.json installed by the install scenarios
```
