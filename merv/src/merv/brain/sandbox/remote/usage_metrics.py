# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Read-only live-usage probe shared by Modal exec and VM SSH.

Missing gauges degrade independently, so CPU-only machines still report what
they can.
"""

from __future__ import annotations

from typing import Any


METRICS_EXEC_TIMEOUT = 15


# Emits CPU, non-cache memory, network, SSH-session, and GPU gauges.
METRICS_SCRIPT = r"""
set -u
now_ns() { date +%s%N; }
# Use double-backed %.0f: mawk's 32-bit %d clamps cumulative CPU counters.
cpu_usage_usec() {
  if [ -r /sys/fs/cgroup/cpu.stat ]; then
    awk '/^usage_usec/{print $2; exit}' /sys/fs/cgroup/cpu.stat
  elif [ -r /sys/fs/cgroup/cpuacct/cpuacct.usage ]; then
    awk '{printf "%.0f", $1/1000}' /sys/fs/cgroup/cpuacct/cpuacct.usage
  fi
}
u1=$(cpu_usage_usec); t1=$(now_ns)
sleep 0.25
u2=$(cpu_usage_usec); t2=$(now_ns)
if [ -n "${u1:-}" ] && [ -n "${u2:-}" ]; then
  awk -v a="$u1" -v b="$u2" -v ta="$t1" -v tb="$t2" \
    'BEGIN{ d=tb-ta; if(d>0) printf "MERV cpu_cores_used=%.4f\n", ((b-a)*1000.0)/d }'
fi
if [ -r /sys/fs/cgroup/cpu.max ]; then
  read -r q p < /sys/fs/cgroup/cpu.max || true
  if [ "${q:-max}" != "max" ] && [ -n "${p:-}" ]; then
    awk -v q="$q" -v p="$p" 'BEGIN{ if(p>0) printf "MERV cpu_cores_limit=%.4f\n", q/p }'
  fi
fi
# gVisor exposes host-level cgroup totals. Derive non-cache memory from meminfo;
# the backend supplies the reserved denominator.
if [ -r /proc/meminfo ]; then
  awk '
    /^MemTotal:/      {t=$2}
    /^MemFree:/       {f=$2}
    /^Buffers:/       {b=$2}
    /^Cached:/        {c=$2}
    /^SReclaimable:/  {s=$2}
    END { u=t-f-b-c-s; if (u<0) u=0; printf "MERV mem_used_bytes=%.0f\n", u*1024 }
  ' /proc/meminfo
fi
if [ -r /proc/net/dev ]; then
  awk 'NR>2{iface=$1; sub(/:/,"",iface); if(iface!="lo") total+=$2+$10}
       END{printf "MERV net_bytes_total=%.0f\n", total}' /proc/net/dev
fi
ssh_sessions() {
  if command -v ss >/dev/null 2>&1; then
    n=$(ss -Htn state established 'sport = :22' 2>/dev/null | wc -l | awk '{print $1}')
  else
    n=$(awk 'NR>1{split($2,a,":"); if(tolower(a[2])=="0016" && $4=="01") c++}
         END{print c+0}' /proc/net/tcp /proc/net/tcp6 2>/dev/null)
  fi
  # This probe arrives over SSH itself: subtract our own session, or the
  # gauge reads >=1 forever and idle reaping can never fire.
  case "${n:-}" in
    ''|*[!0-9]*) ;;
    *) [ -n "${SSH_CONNECTION:-}" ] && [ "$n" -gt 0 ] && n=$((n-1)) ;;
  esac
  printf '%s\n' "${n:-}"
}
ssh_established=$(ssh_sessions || true)
if [ -n "${ssh_established:-}" ]; then
  printf 'MERV ssh_established=%s\n' "$ssh_established"
fi
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,name \
    --format=csv,noheader,nounits 2>/dev/null | \
  while IFS=',' read -r idx util used total name; do
    trim() { echo "$1" | sed 's/^ *//; s/ *$//'; }
    printf 'MERV gpu idx=%s util=%s used=%s total=%s name=%s\n' \
      "$(trim "$idx")" "$(trim "$util")" "$(trim "$used")" "$(trim "$total")" "$(trim "$name")"
  done
fi
echo "MERV ok=1"
"""


def _to_float(value: str | None) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _to_int(value: str | None) -> int | None:
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def _parse_gpu(body: str) -> dict[str, Any] | None:
    name = ""
    head = body
    if " name=" in body:
        head, name = body.split(" name=", 1)
    fields: dict[str, str] = {}
    for token in head.split():
        if "=" in token:
            key, val = token.split("=", 1)
            fields[key] = val
    index = _to_int(fields.get("idx"))
    if index is None:
        return None
    return {
        "index": index,
        "name": name.strip(),
        "util_pct": _to_int(fields.get("util")),
        "mem_used_mib": _to_int(fields.get("used")),
        "mem_total_mib": _to_int(fields.get("total")),
    }


def parse_metrics(output: str) -> dict[str, Any] | None:
    cpu_used = cpu_limit = None
    mem_used = mem_limit = None
    net_bytes = ssh_established = None
    gpus: list[dict[str, Any]] = []
    saw_ok = False
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line.startswith("MERV "):
            continue
        body = line[5:]
        if body.startswith("cpu_cores_used="):
            cpu_used = _to_float(body.split("=", 1)[1])
        elif body.startswith("cpu_cores_limit="):
            cpu_limit = _to_float(body.split("=", 1)[1])
        elif body.startswith("mem_used_bytes="):
            mem_used = _to_int(body.split("=", 1)[1])
        elif body.startswith("mem_limit_bytes="):
            mem_limit = _to_int(body.split("=", 1)[1])
        elif body.startswith("net_bytes_total="):
            net_bytes = _to_int(body.split("=", 1)[1])
        elif body.startswith("ssh_established="):
            ssh_established = _to_int(body.split("=", 1)[1])
        elif body.startswith("gpu "):
            gpu = _parse_gpu(body[4:])
            if gpu is not None:
                gpus.append(gpu)
        elif body.startswith("ok="):
            saw_ok = body.split("=", 1)[1].strip() == "1"
    if (
        not saw_ok
        and cpu_used is None
        and mem_used is None
        and net_bytes is None
        and not gpus
    ):
        return None
    return {
        "cpu": {"used_cores": cpu_used, "limit_cores": cpu_limit},
        "memory": {"used_bytes": mem_used, "limit_bytes": mem_limit},
        "network": {
            "bytes_total": net_bytes,
            "ssh_established": ssh_established,
        },
        "gpus": gpus,
    }
