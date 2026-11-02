#!/bin/sh
# Real machines for the board app, on the board server, as root, from deploy/board.
#   sh renting.sh on    reads the Cloudflare API token on stdin (account-scoped, Workers Containers
#                       Read only: Sandboxes proves a worker's image against Cloudflare's inventory
#                       with it) and turns renting on.
#   sh renting.sh off   back to workers in the app's own process. Sandboxes stays up, renting nothing.
set -eu
ROOT=/etc/merv-board
BRIDGE=https://merv-board-fleet.gural-ac2.workers.dev
APPLICATION=a032a248-549b-496d-9ad2-fadd9868a4e1
IMAGE=sha256:194f1afab4a541a26bc8d8a471aa30559b00f126b493197e7616c7f47e2d57f3
EXECUTABLE=b3f871dcee261fd66d6ccdbbe4d8e589a8ef1014646c920087da4bbc866da49d
compose() { docker compose --env-file "$ROOT/compose.env" "$@"; }
sed -i '/^BOARD_RENT=/d' "$ROOT/env"
case "${1:-}" in
on)
  (umask 077; head -n 1 >"$ROOT/cloudflare-api-token")
  test -s "$ROOT/cloudflare-api-token"
  RELEASE=$(python3 sandboxes-env.py "$BRIDGE" "$APPLICATION" "$IMAGE" "$EXECUTABLE")
  compose up -d --no-deps --force-recreate sandboxes-control sandboxes-gateway
  printf 'BOARD_RENT={"profiles":[{"key":"standard","provider":"cloudflare-fleet","offerId":"standard-1:cloudflare","releaseId":"%s","leaseSeconds":3600}],"dailyUsdPerPerson":20,"globalLimit":10,"slots":3}\n' "$RELEASE" >>"$ROOT/env"
  ;;
off) ;;
*) echo 'usage: renting.sh on|off' >&2; exit 2 ;;
esac
compose up -d --no-deps --build --force-recreate app
