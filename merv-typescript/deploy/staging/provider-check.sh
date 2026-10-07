#!/bin/sh
# Provider live check (~3–5 min, ~$0.02): Modal cpu-2 + gpu-t4 through Sandboxes, and a
# Cloudflare hosted agent machine. See README.md.
#   deploy/staging/provider-check.sh [--skip-cpu] [--skip-gpu] [--skip-cloudflare]
. "$(dirname "$0")/lib.sh"
run_check provider-check provider_check.py "$@"
