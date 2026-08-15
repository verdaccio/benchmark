#!/usr/bin/env bash
# Run a Docker-based, frozen version-comparison sweep and generate its page.
# All default scenarios are measured (warm-install, proxy-install, publish,
# unpublish, search, serve) — same metrics as everything else.
#
# Usage:  scripts/compare-line.sh <label> <comma-separated-versions> [samples]
# Example: scripts/compare-line.sh v6 6.0.5,6.1.6,6.2.9,6.3.2,6.4.0,6.5.2,6.6.2,6.7.4,6.8.0,6.9.2 15
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="${1:?usage: compare-line.sh <label> <versions> [samples]}"
VERSIONS="${2:?usage: compare-line.sh <label> <versions> [samples]}"
SAMPLES="${3:-15}"
OUT="reports/compare-${LABEL}.html"

echo "==> [1/5] Building image (bakes current scripts)"
docker compose build

echo "==> [2/5] Ensuring frozen snapshot in the container volume"
docker compose run --rm bench scripts/snapshot-upstream.mjs   # skips if it already exists

echo "==> [3/5] Benchmarking ${LABEL}: ${VERSIONS}  (frozen, ${SAMPLES} samples, all scenarios)"
docker compose run --rm bench scripts/bench.mjs --frozen --versions "${VERSIONS}" --samples "${SAMPLES}" --warmup 2

echo "==> [4/5] Generating ${OUT} from the latest result"
node scripts/report-compare.mjs --title "Verdaccio ${LABEL} line (frozen)" --output "${OUT}"

echo "==> [5/5] Rebuilding site"
node scripts/build-site.mjs

echo
echo "Done. Review ${OUT} (open _site/index.html), then commit it to pin it:"
echo "    git add ${OUT} && git commit -m 'Update ${LABEL} comparison' && git push"
