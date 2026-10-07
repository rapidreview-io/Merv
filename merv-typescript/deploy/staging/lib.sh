# Sourced by the staging check scripts. Runs one check on the staging VM and appends its
# one-line result to deploy/STAGING_CHECKS.md.
#
#   run_check NAME CHECK.py [ARGS...]
#
# The check's Python (after stg.py) is piped over ssh into `sudo python3 -` on the VM, so tokens
# never leave the VM; the full log is kept locally under $STG_LOG_DIR.
set -u
STG_HOST=${STG_HOST:-azureuser@dev-experiments.rapidreview.io}
STG_DIR=$(cd "$(dirname "$0")" && pwd)
STG_REPO=$(cd "$STG_DIR/../.." && pwd)
STG_LEDGER=$STG_REPO/deploy/STAGING_CHECKS.md
STG_LOG_DIR=${STG_LOG_DIR:-${TMPDIR:-/tmp}/merv-staging-checks}

# Staging only: the checks rebuild runners and create work, so any other host is refused.
case "$STG_HOST" in
  *@dev-experiments.rapidreview.io | dev-experiments.rapidreview.io) ;;
  *) [ "${STG_ALLOW_HOST:-}" = 1 ] || { echo "refusing: $STG_HOST is not the staging VM" >&2; exit 2; } ;;
esac

run_check() {
  name=$1 file=$2
  shift 2
  mkdir -p "$STG_LOG_DIR"
  log=$STG_LOG_DIR/$name-$(date -u +%Y%m%dT%H%M%SZ).log
  started=$(date -u +%s)
  cat "$STG_DIR/stg.py" "$STG_DIR/$file" |
    ssh -o BatchMode=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=6 "$STG_HOST" \
      "sudo env STG_USD_PER_MTOK_IN=${STG_USD_PER_MTOK_IN:-0.25} STG_USD_PER_MTOK_OUT=${STG_USD_PER_MTOK_OUT:-10} python3 -u - $*" 2>&1 |
    tee "$log"
  result=$(grep '^RESULT ' "$log" | tail -1 | cut -c8-)
  python3 - "$STG_LEDGER" "$name" "$started" "$log" "$result" <<'PY'
import json, os, sys, time
ledger, name, started, log, raw = sys.argv[1:6]
if not os.path.exists(ledger):
    with open(ledger, "w") as f:
        f.write("# Staging checks\n\nOne row per run of a script in [staging/](staging/README.md), appended by the "
                "script itself. Cost is an estimate: Modal and machine costs as Sandboxes reports them, model tokens at "
                "the rates in the README. Full logs stay with whoever ran the check.\n\n"
                "| When (UTC) | Check | Result | Runtime | Cost | Image | Details |\n"
                "| --- | --- | --- | --- | --- | --- | --- |\n")
when = time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(int(started)))
try:
    r = json.loads(raw)
except Exception:
    r = {"result": "ERROR", "seconds": int(time.time()) - int(started), "cost_usd": None, "image": "?",
         "failed": ["no RESULT line: see " + os.path.basename(log)], "blocked": [], "counts": {}, "facts": {}}
secs = int(r.get("seconds") or 0)
cost = "?" if r.get("cost_usd") is None else f"${r['cost_usd']:.2f}"
counts = ", ".join(f"{k.lower()} {v}" for k, v in r.get("counts", {}).items() if v)
bits = [counts] if counts else []
if r.get("failed"):
    bits.append("failed: " + "; ".join(r["failed"]))
if r.get("blocked"):
    bits.append("blocked: " + "; ".join(r["blocked"]))
facts = r.get("facts") or {}
if facts:
    bits.append(" ".join(f"{k}={v}" for k, v in facts.items()))
detail = " · ".join(bits).replace("|", "/").replace("\n", " ")
image = (r.get("image") or "?").split(":")[-1]
with open(ledger, "a") as f:
    f.write(f"| {when} | {name} | {r['result']} | {secs // 60}m{secs % 60:02d}s | {cost} | `{image}` | {detail} |\n")
print(f"appended {name} {r['result']} to {os.path.relpath(ledger)}")
sys.exit({"PASS": 0, "PARTIAL": 3}.get(r["result"], 1))
PY
}
