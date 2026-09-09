# Hosted-brain image for Merv.
#
# Installs research HTTP/auth, Postgres, and Merv's R2 evidence client.
# ML compute and workload storage run in the independent merv-sandboxes service.
# syntax=docker/dockerfile:1
FROM python:3.11-slim AS base

# No .pyc churn, unbuffered logs (so the structured JSON log stream reaches the
# platform's log pipeline immediately), pip lean.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# curl is used only by the health probe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the research control plane, including its R2 evidence client.
COPY pyproject.toml README.md ./
COPY src ./src
COPY deploy/db_preflight.py ./deploy/db_preflight.py
RUN pip install ".[control]"

# Run as a non-root user (the control plane never needs root; it holds no user
# checkout).
RUN useradd --create-home --uid 10001 rpcontrol
USER rpcontrol

ENV MERV_MODE=control \
    MERV_HTTP_HOST=0.0.0.0 \
    MERV_HTTP_PORT=8787

EXPOSE 8787

# Liveness via the unauthenticated version handshake (also covers /health). The
# control plane rejects below-floor clients but /api/meta is always open.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8787/api/meta || exit 1

# control_main forces MERV_MODE=control. Keep it behind a TLS-terminating
# private boundary in production.
ENTRYPOINT ["merv-control"]
