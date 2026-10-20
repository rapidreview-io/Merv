#!/bin/sh
# Merv connector installer for __MERV_ORIGIN__ . Needs Node.js 18 or later. No sudo. Re-runnable.
# Running it trusts that Merv server to run code as you, now and each time the connector starts.
main() {
  set -eu
  umask 077
  ORIGIN='__MERV_ORIGIN__'; SHA='__CONNECTOR_SHA256__'
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || { echo "Merv's connector needs Node.js 18 or later (https://nodejs.org). Install it, then run this again." >&2; exit 1; }
  "$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' \
    || { echo "Merv's connector needs Node.js 18 or later; found $("$NODE" -v)." >&2; exit 1; }
  # Downloaded into a private temporary directory and checked. The connector then checks ~/.merv
  # (each directory this person's own and writable by no one else), reads itself through one
  # descriptor, checks the digest again, and copies itself in.
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/merv-connect.XXXXXX")"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsS "$ORIGIN/connect/merv-connect.mjs" -o "$TMP/merv-connect.mjs"
  GOT="$( (shasum -a 256 "$TMP/merv-connect.mjs" 2>/dev/null || sha256sum "$TMP/merv-connect.mjs") | cut -d' ' -f1)"
  [ "$GOT" = "$SHA" ] || { echo "Download check failed. Nothing was installed." >&2; exit 1; }
  "$NODE" "$TMP/merv-connect.mjs" install "$SHA" "$NODE"
}
main "$@"
