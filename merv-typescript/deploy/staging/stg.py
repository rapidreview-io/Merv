# Shared helpers for the staging checks. Runs ON the staging VM as root (the .sh wrappers pipe
# this file, followed by one check's file, into `sudo python3 -`). Standard library only.
#
# Credentials stay on the VM: they are read from /opt/merv-staging-e2e/*.json and sent only as
# bearer headers. Nothing here prints a token, a database URL or a signed link; logs show ids.
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

E2E = "/opt/merv-staging-e2e"
BASE = "http://127.0.0.1:3081"
ORIGIN = "https://rp-control-dev.eastus2.cloudapp.azure.com"
CONTROL = "merv-typescript-control-1"
DB = "deploy-supabase-db-1"
SCHEMA = "merv_ts_staging"
# Who acts: the actor-owned "Staging E2E" project's operator (own runner) or the owner-owned
# "Staging E2E hosted" project's account key (Fleet machines on Cloudflare).
KEYS = {"operator": "operator.json", "hosted": "hosted-key.json"}
# Model price used for the cost ESTIMATE (Merv records tokens, not dollars). Codex input is
# mostly cached, so the input rate is a blended one. Override per run with the env variables.
USD_PER_MTOK_IN = float(os.environ.get("STG_USD_PER_MTOK_IN", "0.25"))
USD_PER_MTOK_OUT = float(os.environ.get("STG_USD_PER_MTOK_OUT", "10"))
_print_lock = threading.Lock()
T0 = time.monotonic()


def log(*parts):
    with _print_lock:
        print(time.strftime("%H:%M:%S", time.gmtime()), *parts, flush=True)


def _token(who):
    with open(f"{E2E}/{KEYS[who]}") as f:
        return json.load(f)["token"]


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


def http(method, path, body=None, who="operator", timeout=90):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "authorization": "Bearer " + _token(who),
            "content-type": "application/json",
            "origin": ORIGIN,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            err = json.loads(raw).get("error", {})
        except Exception:
            err = {}
        raise ApiError(exc.code, err.get("code", "http"), str(err.get("message", raw[:300]))) from None
    return json.loads(raw) if raw else {}


def tool(name, body, who="operator", timeout=90):
    return http("POST", "/tools/" + name, body, who, timeout)["result"]


_db_url = None
_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")


def ident(value):
    """An id safe to put in SQL text; everything else is refused."""
    if not isinstance(value, str) or not _ID.match(value):
        raise ValueError("not an id: %r" % (value,))
    return value


def sql(query):
    """Read-only SQL on the staging schema. Rows as lists of strings."""
    global _db_url
    if _db_url is None:
        env = subprocess.check_output(
            ["docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", CONTROL], text=True
        )
        _db_url = next(l.split("=", 1)[1] for l in env.splitlines() if l.startswith("MERV_DB_URL="))
    out = subprocess.run(
        ["docker", "exec", "-i", "-e",
         f"PGOPTIONS=-c default_transaction_read_only=on -c search_path={SCHEMA}",
         DB, "psql", _db_url, "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1"],
        input=query, capture_output=True, text=True, timeout=120,
    )
    if out.returncode:
        raise RuntimeError("sql failed: " + out.stderr.strip()[:400])
    return [line.split("\t") for line in out.stdout.splitlines() if line]


def state_of(instance_id):
    rows = sql(f"SELECT state FROM wf_instances WHERE id='{ident(instance_id)}';")
    return rows[0][0] if rows else None


def wait_for(what, probe, timeout, every=10):
    """Poll probe() until it returns a truthy value or timeout seconds pass; returns the last value."""
    t0 = time.monotonic()
    value = None
    while time.monotonic() - t0 < timeout:
        try:
            value = probe()
        except Exception as exc:  # a transient read error is retried, not fatal
            log(f"  ({what}: {exc})")
            value = None
        if value:
            return value
        time.sleep(every)
    log(f"  timed out after {timeout}s waiting for {what}")
    return value


def wait_state(instance_id, states, timeout, every=10, who_label=""):
    seen = []

    def probe():
        s = state_of(instance_id)
        if s and (not seen or seen[-1] != s):
            seen.append(s)
            log(f"  {who_label or instance_id} -> {s}")
        return s if s in states else None

    return wait_for(f"{instance_id} in {states}", probe, timeout, every), seen


def usage(instance_id, who="operator"):
    try:
        u = tool("usage.read", {"instanceId": instance_id}, who)["totals"]
    except ApiError as exc:
        log(f"  usage.read {instance_id}: {exc}")
        return {"inputTokens": 0, "outputTokens": 0, "sessions": 0, "reportedSessions": 0}
    return u


def token_cost(u):
    return u.get("inputTokens", 0) / 1e6 * USD_PER_MTOK_IN + u.get("outputTokens", 0) / 1e6 * USD_PER_MTOK_OUT


def image():
    """The live Main image as a tag: a container recreated from an image id reports only the id."""
    ref = subprocess.check_output(["docker", "inspect", "-f", "{{.Config.Image}}", CONTROL], text=True).strip()
    if not ref.startswith("sha256:"):
        return ref
    tags = subprocess.check_output(["docker", "image", "inspect", "-f", "{{range .RepoTags}}{{println .}}{{end}}", ref],
                                   text=True).split()
    tags = [t for t in tags if t.startswith("merv-typescript:")] or tags
    return sorted(tags)[-1] if tags else ref


class Run:
    """Collects PASS/FAIL/SKIP lines and prints one machine-readable RESULT line at the end."""

    def __init__(self, check):
        self.check = check
        self.items = []
        self.cost = 0.0
        self.facts = {}
        self.lock = threading.Lock()

    def ok(self, name, passed, detail=""):
        with self.lock:
            self.items.append((name, "PASS" if passed else "FAIL", detail))
        log(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail else ""))
        return passed

    def skip(self, name, why):
        with self.lock:
            self.items.append((name, "SKIP", why))
        log(f"SKIP {name} — {why}")

    def blocked(self, name, why):
        with self.lock:
            self.items.append((name, "BLOCKED", why))
        log(f"BLOCKED {name} — {why}")

    def add_cost(self, usd, what=""):
        with self.lock:
            self.cost += usd
        if what:
            log(f"  cost +${usd:.4f} {what}")

    def finish(self):
        fails = [n for n, s, _ in self.items if s == "FAIL"]
        blocked = [n for n, s, _ in self.items if s == "BLOCKED"]
        result = "FAIL" if fails else "PARTIAL" if blocked else "PASS"
        counts = {s: sum(1 for _, x, _ in self.items if x == s) for s in ("PASS", "FAIL", "SKIP", "BLOCKED")}
        summary = {
            "check": self.check,
            "result": result,
            "seconds": round(time.monotonic() - T0),
            "cost_usd": round(self.cost, 4),
            "image": image(),
            "counts": counts,
            "failed": fails,
            "blocked": blocked,
            "facts": self.facts,
        }
        log(f"{self.check} {result}: " + ", ".join(f"{k} {v}" for k, v in counts.items() if v))
        print("RESULT " + json.dumps(summary), flush=True)
        return 1 if fails else 0
