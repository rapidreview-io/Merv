#!/bin/sh
# Computers people's agents rent to run code on, on the board server, as root, from deploy/board.
# Nothing to do with renting.sh, where the agent itself runs: that stays off without this.
#   sh compute.sh on [limits]  reads {"token_id","token_secret"} on stdin if no key is kept yet, then
#                              turns it on. limits: BOARD_COMPUTE JSON, default {} (compute.ts's caps).
#   sh compute.sh off          no new rentals, in about a minute. Running ones end with their lease.
#   sh compute.sh remove       off, and the key gone. Do this after the last lease has ended.
set -eu
ROOT=/etc/merv-board
. ./fleet-release.sh
compose() { docker compose --env-file "$ROOT/compose.env" "$@"; }
render() {
  python3 sandboxes-env.py "$BRIDGE" "$APPLICATION" "$IMAGE" "$EXECUTABLE" >/dev/null
  compose up -d --no-deps --force-recreate --wait sandboxes-control
  compose up -d --no-deps --force-recreate sandboxes-gateway
}
sed -i '/^BOARD_COMPUTE=/d' "$ROOT/env"
case "${1:-}" in
on)
  if [ ! -s "$ROOT/modal-key" ]; then
    (umask 077; head -n 1 >"$ROOT/modal-key")
    test -s "$ROOT/modal-key"
  fi
  render
  limits='{}'
  if [ $# -ge 2 ]; then limits=$2; fi
  printf 'BOARD_COMPUTE=%s\n' "$limits" >>"$ROOT/env"
  ;;
off) ;;
remove)
  rm -f "$ROOT/modal-key"
  render
  ;;
*) echo 'usage: compute.sh on [limits] | off | remove' >&2; exit 2 ;;
esac
compose up -d --no-deps --build --force-recreate app
