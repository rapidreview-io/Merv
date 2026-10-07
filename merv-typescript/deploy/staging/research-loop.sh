#!/bin/sh
# T1 research loop (≤45 min, ≤$2): dataset task → experiment trained on Modal → reviews. See README.md.
#   deploy/staging/research-loop.sh [TAG] [--project hosted|e2e]     (default: the owner-owned hosted project)
. "$(dirname "$0")/lib.sh"
case "${1:-}" in -* | '') TAG=$(date -u +%H%M%S) ;; *) TAG=$1; shift ;; esac
run_check research-loop research_loop.py "$TAG" "$@"
