#!/usr/bin/env bash
# Throwaway version comparison, fully inside Docker. All benchmark work runs in
# the container; this launcher only invokes `docker compose`. Output goes to a
# host temp dir mounted into the container, so NOTHING is written to results/,
# reports/, or results/history/runs.json — no trace to commit.
#
# Usage:  scripts/compare-tmp.sh --versions v6=6.0.5,v7=7.0.0-next-7.23 [--scenarios publish] [--samples 5] [--title "..."]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="$(mktemp -d "${TMPDIR:-/tmp}/vbench-compare.XXXXXX")"

echo "==> [1/2] Building image (bakes current scripts)"
docker compose build

echo "==> [2/2] Running comparison in container (output -> ${OUT})"
docker compose run --rm -v "${OUT}:/out" bench scripts/compare-tmp.mjs --out /out "$@"

echo
echo "Temporary comparison ready — nothing committed, runs.json untouched:"
echo "  report: ${OUT}/compare.html"
echo
echo "  open \"${OUT}/compare.html\""
