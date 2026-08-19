#!/usr/bin/env bash
# Full benchmark suite across the latest 5.x / 6.x / 7.x / master, then build the
# dashboard. Everything runs in Docker: 5.x is the npm `latest-5`, the others are
# the published Docker images (run as sibling containers via docker-out-of-docker).
#
# Usage:  scripts/bench-all.sh [samples]        # default samples: 10 (core), monorepo/bigpkg tuned
# Heavy: expect ~30-60 min. Raw results land in results/ (gitignored); HTML in reports/.
set -euo pipefail
cd "$(dirname "$0")/.."

SAMPLES="${1:-10}"
VERSIONS="v5=latest-5,v6=docker:verdaccio/verdaccio:6.x-next,v7=docker:verdaccio/verdaccio:7.x-next,master=docker:verdaccio/verdaccio:nightly-master"

echo "==> [0/5] Building image + pulling fresh published tags"
docker compose build
for t in 6.x-next 7.x-next nightly-master; do docker pull "verdaccio/verdaccio:$t"; done

run() { docker compose run --rm bench scripts/bench.mjs "$@"; }
latest_json() { ls -t results/bench-*.json | head -1; }

echo "==> [1/5] Core scenarios (install / publish / unpublish / serve / search)"
run --scenarios warm-install,proxy-install,publish,unpublish,serve,search \
    --versions "$VERSIONS" --samples "$SAMPLES"
CORE_JSON="$(latest_json)"

echo "==> [2/5] Monorepo publish (100 packages)"
run --scenarios monorepo --versions "$VERSIONS" \
    --monorepo-packages 100 --samples 2 --warmup 1
MONO_JSON="$(latest_json)"

echo "==> [3/5] Large packuments / package-filter (typescript, next, ...)"
run --scenarios bigpkg --versions "$VERSIONS" --upstream npmjs \
    --serve-requests 100 --serve-concurrency 10
BIG_JSON="$(latest_json)"

echo "==> [4/5] Rendering reports"
node scripts/report.mjs --input "$CORE_JSON"                                                          # per-run page + runs.json
node scripts/report-compare.mjs --input "$CORE_JSON" --title "Verdaccio 5/6/7/master — core" --output reports/compare-all.html
node scripts/report-monorepo.mjs --input "$MONO_JSON" --title "Verdaccio 5/6/7/master — monorepo (100 pkgs)" --output reports/monorepo.html
node scripts/report-bigpkg.mjs --input "$BIG_JSON" --title "Verdaccio 5/6/7/master — large packuments" --output reports/bigpkg.html

echo "==> [5/5] Building site"
node scripts/build-site.mjs

echo
echo "Done. Open the dashboard:"
echo "    open _site/index.html"
echo "Pinned pages: reports/compare-all.html · reports/monorepo.html · reports/bigpkg.html"
