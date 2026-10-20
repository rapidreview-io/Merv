#!/bin/sh
# Merv connector installer for __MERV_ORIGIN__ . Needs Node.js 18 or later. No sudo. Re-runnable.
# Running it trusts that Merv server to run code as you, now and each time the connector starts.
main() {
  set -eu
  umask 077
  ORIGIN='__MERV_ORIGIN__'; HOSTDIR='__MERV_HOSTDIR__'; SHA='__CONNECTOR_SHA256__'
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || { echo "Merv's connector needs Node.js 18 or later (https://nodejs.org). Install it, then run this again." >&2; exit 1; }
  "$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' \
    || { echo "Merv's connector needs Node.js 18 or later; found $("$NODE" -v)." >&2; exit 1; }
  case "$NODE" in *"'"*) echo "Unsupported node path: $NODE" >&2; exit 1;; esac
  for d in "$HOME/.merv" "$HOME/.merv/connect" "$HOME/.merv/connect/$HOSTDIR" "$HOME/.merv/connect/$HOSTDIR/bin"; do
    [ ! -L "$d" ] || { echo "Refusing: $d is a symlink. Nothing was installed." >&2; exit 1; }
    [ -d "$d" ] || mkdir -m 700 "$d"
    [ -O "$d" ] || { echo "Refusing: $d is not owned by you. Nothing was installed." >&2; exit 1; }
  done
  DIR="$HOME/.merv/connect/$HOSTDIR"
  for f in "$DIR/merv-connect.mjs" "$DIR/bin/merv-connect"; do
    [ ! -d "$f" ] || { echo "Refusing: $f is a directory. Nothing was installed." >&2; exit 1; }
  done
  chmod 700 "$HOME/.merv/connect" "$DIR" "$DIR/bin"
  JS="$(mktemp "$DIR/.merv-connect.XXXXXX")"; SH="$(mktemp "$DIR/bin/.merv-connect.XXXXXX")"
  trap 'rm -f "$JS" "$SH"' EXIT
  curl -fsS "$ORIGIN/connect/merv-connect.mjs" -o "$JS"
  GOT="$( (shasum -a 256 "$JS" 2>/dev/null || sha256sum "$JS") | cut -d' ' -f1)"
  [ "$GOT" = "$SHA" ] || { echo "Download check failed. Nothing was installed." >&2; exit 1; }
  printf '#!/bin/sh\nN=%s\n[ -x "$N" ] || N="$(command -v node)"\nexec "$N" "$HOME/.merv/connect/%s/merv-connect.mjs" "$@"\n' "'$NODE'" "$HOSTDIR" > "$SH"
  chmod 600 "$JS"; chmod 700 "$SH"
  mv -f "$JS" "$DIR/merv-connect.mjs"
  mv -f "$SH" "$DIR/bin/merv-connect"
  trap - EXIT
  "$DIR/bin/merv-connect" install
}
main "$@"
