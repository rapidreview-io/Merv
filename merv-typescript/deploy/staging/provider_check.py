# Provider live check: appended to stg.py and run on the staging VM by provider-check.sh.
# argv: [-, --skip-cpu | --skip-gpu | --skip-cloudflare ...]
#
#  1. Modal through the Sandboxes API, in the staging-compute namespace (the only GPU provider):
#     cpu-2 and gpu-t4 are each rented, timed to ready, given a tiny job whose output is checked,
#     and released. Nothing may be left running: every rental reaches `stopped`, the namespace
#     lists no live sandbox, and the cost stops growing. This is verified through the Sandboxes
#     API (no Modal credentials on staging), which reads presence from Modal itself.
#  2. Cloudflare: a staging hosted agent machine (pi.warm in the E2E project) reaches ready and is
#     stopped again.
# Records time-to-ready and cost of each. Every rental is released in a finally block.
import urllib.parse
import uuid

ARGS = set(sys.argv[1:])
run = Run("provider-check")
SBX = json.load(open(f"{E2E}/sandboxes-staging-compute.json"))  # consumer token, never printed
LEASE_SECONDS = 900  # well under Modal's 1 h kill
READY_TIMEOUT = 900  # a cold torch image build takes minutes
CPU_JOB = "python3 -c \"import platform; print('CPU_OK', sum(i*i for i in range(1000)), platform.machine())\""
GPU_JOB = r"""set -e
nvidia-smi -L
python - <<'PY'
import torch
assert torch.cuda.is_available(), "no CUDA"
torch.manual_seed(0)
a = torch.ones(256, 256, device="cuda")
s = (a @ a).sum().item()
print("GPU_OK", torch.cuda.get_device_name(0), int(s))
PY
"""


def sbx(method, path, body=None, **query):
    qs = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
    req = urllib.request.Request(
        SBX["url"] + "/v1" + path + ("?" + qs if qs else ""), method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + SBX["token"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        raise ApiError(exc.code, "sandboxes", exc.read().decode(errors="replace")[:400]) from None
    return json.loads(raw) if raw else {}


def job_output(job_id, stream="stdout"):
    req = urllib.request.Request(f"{SBX['url']}/v1/jobs/{job_id}/output?stream={stream}&max_bytes=200000",
                                 headers={"Authorization": "Bearer " + SBX["token"]})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read().decode(errors="replace")


def money(m):
    try:
        return float((m or {}).get("amount") or 0)
    except (TypeError, ValueError):
        return 0.0


rented = []


def modal(offer, label, command, expect, timeout):
    t0 = time.monotonic()
    rec = sbx("POST", "/sandboxes", {"provider": "modal", "offer_id": offer, "name": label,
                                     "lease_seconds": LEASE_SECONDS, "idempotency_key": f"{label}-{uuid.uuid4().hex[:12]}"})
    rented.append(rec["id"])
    log(f"  rent {offer}: {rec['id']} {rec['state']}")
    try:
        while True:
            rec = sbx("GET", f"/sandboxes/{rec['id']}", wait=30)
            if rec["state"] == "ready":
                break
            if rec["state"] in ("failed", "stopped", "deleting"):
                raise RuntimeError(f"{rec['id']} became {rec['state']}: {rec.get('last_error')}")
            if time.monotonic() - t0 > READY_TIMEOUT:
                raise RuntimeError(f"{rec['id']} not ready after {READY_TIMEOUT}s")
        ready = time.monotonic() - t0
        log(f"  ready {rec['id']} in {ready:.1f}s")
        j0 = time.monotonic()
        job = sbx("POST", f"/sandboxes/{rec['id']}/jobs", {"name": f"{label}-job", "command": command,
                                                          "timeout_seconds": timeout, "idempotency_key": uuid.uuid4().hex})
        while job["state"] not in ("succeeded", "failed", "cancelled", "timed_out"):
            job = sbx("GET", f"/jobs/{job['id']}", wait=30, after=job.get("cursor") or None)
        out = job_output(job["id"])
        line = next((l for l in out.splitlines() if l.startswith(expect.split()[0])), "")
        log(f"  job {job['id']} {job['state']} exit={job.get('exit_code')} in {time.monotonic() - j0:.1f}s: {line[:120]}")
        if job["state"] != "succeeded":
            log("  stderr: " + job_output(job["id"], "stderr")[-600:])
        job_ok = job["state"] == "succeeded" and line.startswith(expect)
        return ready, job_ok, line, money(job.get("cost"))
    finally:
        release(rec["id"])


def release(sid):
    t0 = time.monotonic()
    try:
        sbx("DELETE", f"/sandboxes/{sid}")
    except ApiError as exc:
        log(f"  release {sid}: {exc}")
    while time.monotonic() - t0 < 300:
        r = sbx("GET", f"/sandboxes/{sid}", wait=20)
        if r["state"] in ("stopped", "failed"):
            log(f"  released {sid}: {r['state']} in {time.monotonic() - t0:.1f}s")
            return
    log(f"  WARNING {sid} not stopped after 300s")


def check_modal(kind, offer, command, expect, timeout):
    try:
        ready, ok, line, job_cost = modal(offer, f"stg-check-{kind}", command, expect, timeout)
    except Exception as exc:
        run.ok(f"Modal {offer}: rent, job, release", False, f"{type(exc).__name__}: {exc}")
        return
    run.facts[f"{kind}_ready_s"] = round(ready, 1)
    run.ok(f"Modal {offer}: ready, tiny job output checked, released", ok, f"ready {ready:.1f}s · {line[:80]}")


def nothing_left():
    """Through the Sandboxes API: our rentals stopped, nothing live in the namespace, cost frozen."""
    if not rented:
        return
    live = sbx("GET", "/sandboxes")["sandboxes"]
    mine = [sbx("GET", f"/sandboxes/{sid}") for sid in rented]
    first = {r["id"]: money(r.get("cost_so_far")) for r in mine}
    time.sleep(15)
    again = {sid: money(sbx("GET", f"/sandboxes/{sid}").get("cost_so_far")) for sid in rented}
    total = sum(again.values())
    run.add_cost(total, "Modal machines (Sandboxes cost_so_far)")
    states = {r["id"]: r["state"] for r in mine}
    run.ok("Modal: nothing left running (Sandboxes API)",
           not live and all(s == "stopped" for s in states.values()) and first == again,
           f"live in namespace {[r['id'] for r in live]}, ours {states}, cost frozen {first == again} ${total:.4f}")


def cloudflare():
    t0 = time.monotonic()
    conv = None
    try:
        snap = tool("pi.snapshot", {"id": tool("pi.create", {"requestId": "stg-check-" + uuid.uuid4().hex[:8],
                                                              "title": "Provider check"})["id"]})
        conv = snap["conversation"]["id"]
        if snap["host"].get("state") not in (None, "none", "stopped", "absent"):
            log(f"  a machine is already {snap['host'].get('state')}: stopping it first")
            tool("pi.machine.stop", {})
            wait_for("machine stopped", lambda: tool("pi.snapshot", {"id": conv})["host"].get("state") != "ready", 120, 3)
        t0 = time.monotonic()
        tool("pi.warm", {"conversationId": conv, "requestId": "stg-check-warm-" + uuid.uuid4().hex[:8]})
        host = wait_for("hosted machine ready",
                        lambda: (lambda h: h if h.get("state") == "ready" else None)(tool("pi.snapshot", {"id": conv})["host"]),
                        600, 2)
        ready = time.monotonic() - t0
        machine = (host or {}).get("machine") or {}
        run.facts["cloudflare_ready_s"] = round(ready, 1)
        run.ok("Cloudflare hosted agent machine ready", bool(host), f"{machine.get('label')} in {ready:.1f}s")
    finally:
        try:
            tool("pi.machine.stop", {})
        except Exception as exc:
            log(f"  pi.machine.stop: {exc}")
    alive = time.monotonic() - t0
    run.add_cost(alive / 3600 * float(machine.get("maxHourlyUsd") or 0.074016), "Cloudflare machine (upper bound)")
    stopped = wait_for("hosted machine stopped",
                       lambda: (lambda s: s if s not in ("ready", "starting", "stopping") else None)(
                           tool("pi.snapshot", {"id": conv})["host"].get("state")), 180, 3)
    run.ok("Cloudflare hosted machine stopped again", bool(stopped), f"state {stopped}")


try:
    me = sbx("GET", "/auth/me")
    offers = {o["offer_id"]: o for o in sbx("GET", "/options", provider="modal", all_options="true")["offers"]}
    run.ok("Modal offers listed in staging-compute", {"cpu-2:modal", "gpu-t4:modal"} <= set(offers),
           f"namespace {me['namespace']} token {me['token_id']}, {len(offers)} offers")
    if "--skip-cpu" not in ARGS:
        log("1a. Modal cpu-2")
        check_modal("cpu2", "cpu-2:modal", CPU_JOB, "CPU_OK 332833500", 120)
    if "--skip-gpu" not in ARGS:
        log("1b. Modal gpu-t4")
        check_modal("t4", "gpu-t4:modal", GPU_JOB, "GPU_OK Tesla T4 16777216", 300)
finally:
    for sid in rented:  # belt and braces: anything not stopped is released again
        try:
            if sbx("GET", f"/sandboxes/{sid}")["state"] not in ("stopped", "failed"):
                release(sid)
        except Exception as exc:
            log(f"  cleanup {sid}: {exc}")
nothing_left()
if "--skip-cloudflare" not in ARGS:
    log("2. Cloudflare agent machine")
    try:
        cloudflare()
    except Exception as exc:
        run.ok("Cloudflare hosted agent machine", False, f"{type(exc).__name__}: {exc}")
sys.exit(run.finish())
