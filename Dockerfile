# Reproducible environment for the Verdaccio benchmark.
# Node 24 (matches engines) + ApacheBench (ab) for the serve scenario.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends apache2-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Keep npm's update notice off stdout/stderr so it can't pollute output.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# Only what the harness needs to run.
COPY package.json ./
COPY scripts ./scripts
COPY fixtures ./fixtures

# Mount these to persist between runs / extract results (see docker-compose.yml).
#  - results, reports: outputs
#  - .cache: installed Verdaccio binaries + primed upstream (speeds reruns)
VOLUME ["/app/results", "/app/reports", "/app/.cache"]

# `docker run <img> scripts/bench.mjs ...` or `... scripts/report.mjs`.
ENTRYPOINT ["node"]
# Default: the four versions you asked for.
CMD ["scripts/bench.mjs", "--versions", "v6=latest,v7=next-7,v9=next-9,v5=latest-5"]
