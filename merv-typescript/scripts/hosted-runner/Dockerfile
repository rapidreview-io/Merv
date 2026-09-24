# Candidate image only until the provider gates pass.
# Context: output from build.mjs. No host credentials/config are copied.
ARG SANDBOX_IMAGE=merv-runtime-integration:test
FROM node:22.19.0-bookworm-slim AS codex
RUN npm install --prefix /opt/codex --omit=dev --no-audit --no-fund @openai/codex@0.155.0-alpha.2
FROM node:22.19.0-bookworm-slim AS pi-deps
WORKDIR /opt/merv/pi
COPY pi/package.json pi/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --engine-strict --no-audit --no-fund \
 && find node_modules -type d -name .bin -prune -exec rm -rf {} +
FROM ${SANDBOX_IMAGE}
COPY --from=codex /usr/local/bin/node /usr/local/bin/node
COPY --from=codex /opt/codex /opt/codex
COPY --from=pi-deps /opt/merv/pi/node_modules /opt/merv/pi/node_modules
COPY smoke-supervisor.mjs supervisor.mjs /opt/merv/runner/
COPY pi/worker-main.mjs pi/package.json /opt/merv/pi/
COPY start-runtime.py /opt/merv/runtime/start-runtime.py
COPY assignment-probed.py isolation_probe.py /opt/merv/runtime/
COPY start /opt/merv/runtime/start-runner
RUN apt-get update && apt-get install -y --no-install-recommends socat git && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/merv/bin \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/codex/node_modules/@openai/codex/bin/codex.js "$@"\n' > /opt/merv/bin/codex \
 && chmod 0755 /opt/merv/bin/codex /opt/merv/runtime/start-runner /opt/merv/runtime/start-runtime.py /opt/merv/runtime/assignment-probed.py
