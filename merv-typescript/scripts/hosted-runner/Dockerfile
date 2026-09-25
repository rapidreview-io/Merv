# Candidate image only until the provider gates pass. deploy/hosted-release.mjs builds it on the
# production host: the context is build.mjs's output and SANDBOX_IMAGE is the Sandboxes base built
# from its committed Cloudflare Dockerfile. No host credentials/config are copied. Every copy sets
# its mode, whatever the context's. The Pi worker is copied last, so a worker-only change leaves
# every other layer, and every file outside /opt/merv/pi, as it was.
ARG SANDBOX_IMAGE=merv-runtime-integration:test
FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS codex
RUN npm install --prefix /opt/codex --omit=dev --no-audit --no-fund @openai/codex@0.155.0-alpha.2
FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS pi-deps
WORKDIR /opt/merv/pi
COPY pi/package.json pi/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --engine-strict --no-audit --no-fund \
 && find node_modules -type d -name .bin -prune -exec rm -rf {} +
FROM ${SANDBOX_IMAGE}
# The Sandboxes base only warns when its agent is missing; this image refuses to build without it.
RUN test -x /usr/local/bin/sandboxes-agent \
 && apt-get update && apt-get install -y --no-install-recommends socat git && rm -rf /var/lib/apt/lists/*
COPY --from=codex /usr/local/bin/node /usr/local/bin/node
COPY --from=codex /opt/codex /opt/codex
COPY --from=pi-deps /opt/merv/pi/node_modules /opt/merv/pi/node_modules
COPY --chmod=0644 smoke-supervisor.mjs supervisor.mjs /opt/merv/runner/
COPY --chmod=0644 isolation_probe.py /opt/merv/runtime/
COPY --chmod=0755 start-runtime.py assignment-probed.py boot /opt/merv/runtime/
COPY --chmod=0755 start /opt/merv/runtime/start-runner
RUN mkdir -p /opt/merv/bin \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/codex/node_modules/@openai/codex/bin/codex.js "$@"\n' > /opt/merv/bin/codex \
 && chmod 0755 /opt/merv/bin/codex
COPY --chmod=0644 pi/worker-main.mjs pi/package.json /opt/merv/pi/
# Node keys its compile cache by UID, so the worker's identity fills it once and root then seals it.
RUN install -d -o 12001 -g 12001 -m 0700 /opt/merv/pi/compile-cache
USER 12001:12001
RUN cd /home/assignment && NODE_COMPILE_CACHE=/opt/merv/pi/compile-cache \
      /usr/local/bin/node /opt/merv/pi/worker-main.mjs </dev/null 2>/dev/null; \
    test -n "$(ls -A /opt/merv/pi/compile-cache/*-12001)"
USER root
RUN chown -R 0:0 /opt/merv/pi/compile-cache && chmod -R u=rwX,go=rX /opt/merv/pi/compile-cache
ENTRYPOINT ["/opt/merv/runtime/boot"]
