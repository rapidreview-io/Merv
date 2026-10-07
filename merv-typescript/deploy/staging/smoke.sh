#!/bin/sh
# T0 smoke for every staging release (~20 min, well under $1). See README.md.
#   deploy/staging/smoke.sh [TAG]      TAG makes request ids unique (default: the UTC time)
. "$(dirname "$0")/lib.sh"
run_check smoke smoke.py "${1:-$(date -u +%H%M%S)}"
