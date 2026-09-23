# Acceptance image only until managed enrollment and provider gates pass.
# Context: output from build.mjs. No host credentials/config are copied.
ARG SANDBOX_IMAGE=merv-runtime-integration:test
FROM node:22.13.1-bookworm-slim AS codex
RUN npm install --prefix /opt/codex --omit=dev --no-audit --no-fund @openai/codex@0.155.0-alpha.2
FROM ${SANDBOX_IMAGE}
COPY --from=codex /usr/local/bin/node /usr/local/bin/node
COPY --from=codex /opt/codex /opt/codex
COPY smoke-supervisor.mjs supervisor.mjs /opt/merv/runner/
COPY start /opt/merv/runtime/start-runner
RUN apt-get update && apt-get install -y --no-install-recommends socat && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/merv/bin \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/codex/node_modules/@openai/codex/bin/codex.js "$@"\n' > /opt/merv/bin/codex \
 && chmod 0755 /opt/merv/bin/codex /opt/merv/runtime/start-runner
