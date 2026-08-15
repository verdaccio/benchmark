# Verdaccio benchmark

Compares Verdaccio behavior across release tags (`latest`, `next-7`, `next-9`, …) on the
operations that matter to a registry: installing, proxying, publishing, unpublishing,
searching, and raw HTTP serving. **npm** is the reference client.

## Requirements

- **Docker** (Docker Desktop running) — everything runs in a container, no host tooling needed.
- **pnpm** — to invoke the `pnpm …` scripts below.

```sh
docker version        # must print a Server version
pnpm docker:build     # build the image once (rebuild after changing scripts/)
```

## Compare two versions

Runs entirely in Docker and writes a throwaway report to a temp dir — nothing is committed
(`results/`, `reports/`, `runs.json` are untouched):

```sh
pnpm bench:compare -- --versions v6=6.0.5,v7=7.0.0-next-7.23
```

- `--versions label=spec,…` — `spec` is a tag (`latest`, `next-7`) or exact version (`6.0.5`).
- add `--scenarios publish` and `--samples 5` for a quicker run.

When it finishes it prints an `open` line — run it to view the comparison in your browser:

```sh
open "/var/folders/…/vbench-compare.XXXXXX/compare.html"
```

### More examples

```sh
# just publish + unpublish, 3 versions of the 6.x line
pnpm bench:compare -- --versions v605=6.0.5,v616=6.1.6,v692=6.9.2 --scenarios publish,unpublish --samples 10

# reproducible, offline (uses a frozen npm snapshot — see BENCHMARK.md)
pnpm bench:compare -- --versions v6=6.0.5,v9=next-9 --frozen --samples 10
```

## Other commands

```sh
pnpm docker:bench                 # full run, default versions × all scenarios → results/
pnpm docker:report                # render the newest results to reports/*.html
```

## Documentation

See **[BENCHMARK.md](BENCHMARK.md)** for the full reference: scenarios, all options, Docker
usage, frozen snapshots, committed comparison pages, historical data, the dashboard, and
methodology.
