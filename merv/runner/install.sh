#!/bin/sh
# Install the standalone Merv auto-run client, then start it. On a machine
# that is not yet paired, the runner prints a short code to enter in Merv
# Settings → Auto running and begins dispatching as soon as it is approved.
set -eu

BASE_URL="${MERV_RUNNER_BASE_URL:-https://rapidreview.io/merv/runner}"
RUNNER_HOME="${MERV_RUNNER_HOME:-$HOME/.merv/runner}"
BIN_DIR="${MERV_RUNNER_BIN_DIR:-$HOME/.merv/bin}"
ARCHIVE="$RUNNER_HOME/merv-runner.pyz"

find_python() {
  for candidate in "${MERV_RUNNER_PYTHON:-}" python3.13 python3.12 python3.11 python3; do
    [ -n "$candidate" ] || continue
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

PYTHON_BIN="$(find_python || true)"
if [ -z "$PYTHON_BIN" ]; then
  echo "Merv runner requires Python 3.11 or newer." >&2
  echo "Install Python 3, then run this command again." >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "Merv runner installation requires curl." >&2
  exit 2
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Merv auto-run requires Git for isolated worktrees." >&2
  exit 2
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/merv-runner.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
curl -fsSL "$BASE_URL/merv-runner.pyz" -o "$TEMP_DIR/merv-runner.pyz"
curl -fsSL "$BASE_URL/SHA256SUMS" -o "$TEMP_DIR/SHA256SUMS"
EXPECTED="$(awk '$2 == "merv-runner.pyz" {print $1}' "$TEMP_DIR/SHA256SUMS")"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TEMP_DIR/merv-runner.pyz" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TEMP_DIR/merv-runner.pyz" | awk '{print $1}')"
else
  ACTUAL="$(openssl dgst -sha256 "$TEMP_DIR/merv-runner.pyz" | awk '{print $NF}')"
fi
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Merv runner checksum verification failed." >&2
  exit 2
fi

mkdir -p "$RUNNER_HOME" "$BIN_DIR"
chmod 700 "$RUNNER_HOME" "$BIN_DIR"
chmod 755 "$TEMP_DIR/merv-runner.pyz"
mv "$TEMP_DIR/merv-runner.pyz" "$ARCHIVE.new"
mv "$ARCHIVE.new" "$ARCHIVE"

write_launcher() {
  name="$1"
  mode="$2"
  target="$BIN_DIR/$name"
  {
    echo '#!/bin/sh'
    printf 'export MERV_RUNNER_BIN_DIR=%s\n' "$(printf %s "$BIN_DIR" | sed "s/'/'\\''/g" | sed "s/^/'/;s/$/'/")"
    printf 'exec %s %s %s "$@"\n' \
      "$(printf %s "$PYTHON_BIN" | sed "s/'/'\\''/g" | sed "s/^/'/;s/$/'/")" \
      "$(printf %s "$ARCHIVE" | sed "s/'/'\\''/g" | sed "s/^/'/;s/$/'/")" \
      "$mode"
  } > "$target.new"
  chmod 755 "$target.new"
  mv "$target.new" "$target"
}

write_launcher merv-runner runner
write_launcher merv-agent-runner runner
write_launcher merv-client client

echo "Installed Merv runner in $RUNNER_HOME"
echo "Runner command: $BIN_DIR/merv-agent-runner"
# Install the Merv skills every auto-run child reads and show, per configured
# agent, whether its harness is ready. Advisory here: an unconfigured machine
# has no platforms yet, and the runner repeats the check in its heartbeat.
"$BIN_DIR/merv-client" harness || true

if [ "${1:-}" = "--install-only" ]; then
  exit 0
fi
# Pairs on first run (prints the code for Settings → Auto running), then keeps
# dispatching for the paired project. Extra arguments pass through, e.g. a
# `--project` for a headless MERV_MCP_KEY setup.
exec "$BIN_DIR/merv-agent-runner" "$@"
