# Verdaccio install benchmark

This project compares package installation performance across these Verdaccio npm tags:

- `latest`
- `next-7`
- `next-9`

The benchmark focuses on Verdaccio as a registry used by package managers. It starts isolated Verdaccio instances, points package manager installs at them, and records install durations.

By default it also starts a local upstream Verdaccio registry with persistent storage in `.cache/upstream-storage`. That upstream is primed with the fixture dependencies once and then reused, so measured runs use localhost instead of depending on npmjs.org network behavior.

## Reasonable plan

1. Measure the workflow users actually feel: install dependencies from a client project through Verdaccio.
2. Compare the same scenario across `latest`, `next-7`, and `next-9`.
3. Separate cold and warm behavior:
   - cold Verdaccio storage: first install against an empty registry cache.
   - warm Verdaccio storage: prime the registry once, then measure a fresh client install against cached metadata/tarballs.
4. Keep client caches isolated per run so npm/pnpm/yarn do not hide registry differences.
5. Run several samples per scenario and compare median/p95 instead of trusting one timing.
6. Keep config identical across versions: same uplink, storage shape, auth disabled for public reads.
7. Store raw measurements in `results/` so regressions can be inspected later.

## Current published tags

Checked on 2026-07-26:

- `latest`: `6.8.0`
- `next-7`: `7.0.0-next-7.23`
- `next-9`: `9.0.0-next-9.22`

The runner uses tags by default, not pinned versions. To pin exact versions, pass:

```sh
node scripts/bench-install.mjs --versions latest=6.8.0,next-7=7.0.0-next-7.23,next-9=9.0.0-next-9.22
```

## Run

From this folder:

```sh
pnpm bench
```

Useful variants:

```sh
pnpm bench:npm
pnpm bench:pnpm
pnpm bench:yarn
pnpm bench:hyperfine
pnpm report:hyperfine
node scripts/bench-install.mjs --samples 5 --clients npm,pnpm
node scripts/bench-hyperfine-warm.mjs --clients npm --runs 10 --warmup 2
node scripts/bench-install.mjs --upstream npmjs --samples 3 --clients npm
```

The built-in runner writes:

- `results/install-benchmark-<timestamp>.json`
- `results/install-benchmark-<timestamp>.csv`

The hyperfine warm runner writes:

- `results/hyperfine-warm-<client>-<timestamp>.json`
- `results/hyperfine-warm-<client>-<timestamp>.csv`

The report generator writes:

- `reports/hyperfine-warm-<client>-<timestamp>.html`

## Notes

- The first run includes the cost of `npx` resolving/downloading the Verdaccio binaries and priming `.cache/upstream-storage`. Run once as a preparation pass, then run again for cleaner numbers.
- Default cold measurements fetch from the local upstream cache, not directly from npmjs.org.
- Warm measurements are the best signal for Verdaccio serving cached package metadata and tarballs.
- Do not compare results across machines unless CPU, disk, network, Node version, and package-manager versions are controlled.

## Tools

- Primary tool for warm install comparison: `hyperfine`, because it benchmarks whole commands such as `npm install --registry ...`.
- Primary tool for cold install comparison: `scripts/bench-install.mjs`, because every cold sample needs a fresh Verdaccio storage and server lifecycle.
- Not primary: `ab`, because it benchmarks raw HTTP endpoints and does not model package-manager resolution, cache behavior, lockfile behavior, or tarball concurrency.
- Useful follow-up: `autocannon` or `ab` against specific manifest/tarball URLs only after the install benchmark shows a regression worth isolating.
