# T0 smoke: appended to stg.py and run on the staging VM by smoke.sh. argv: [-, TAG]
#
#  1. Rebuild the E2E runner FROM the live staging Main image, under a restart loop.
#  2. Slow task on the E2E project's own runner; SIGKILL the runner while the producer streams;
#     the agent survives, the stream has no gaps or duplicates, the task is done after review.
#  3. Review back-edge: a task whose first review returns needs_changes (the brief stages it and
#     the operator steers the first reviewer with session.message). The producer's second visit
#     must RESUME the same thread: one producer thread, two visits, the second resumed.
#  4. Thread reads: session.threads, GET /sessions/threads?instanceId= and
#     GET /sessions/threads/:id/conversation return every visit with its events.
#  5. Hold and release: a runner whose harness exits at once (crash_loop) until dispatch holds
#     the target; session.release_hold lets a healthy runner take it again.
#  6. Pi canary on a staging hosted machine (Cloudflare); the machine is released.
#  7. Fleet hosted task in the owner-owned project reaches done.
#  8. Main's logs since the start show no uncaught crash and no restart.
import secrets

TAG = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else time.strftime("%H%M%S", time.gmtime())
run = Run("smoke")
START = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
RESTARTS0 = subprocess.check_output(["docker", "inspect", "-f", "{{.RestartCount}}", CONTROL], text=True).strip()
RUNNER = "merv-staging-runner"
CRASH = "merv-staging-crashrunner"
DOCKER_RUN = (
    "docker run -d --name {name} --restart {restart} --network host --security-opt seccomp=unconfined "
    "--security-opt apparmor=unconfined --env-file {d}/runner.env -e HOME=/home/node -v {home}:/home/node "
    "-v {data}:/data --entrypoint sh merv-staging-runner:latest -c "
    "'while true; do node dist/src/cli.js runner --config /data/runner.json; echo runner-exited-$?; sleep 2; done'"
)
instances = {}  # label -> (instance id, who) for the cost total


def bash(cmd, timeout=600):
    out = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True, timeout=timeout)
    if out.returncode:
        raise RuntimeError(f"command failed ({out.returncode}): {out.stderr.strip()[-400:]}")
    return out.stdout.strip()


def start_runner():
    bash(f"docker rm -f {RUNNER} >/dev/null 2>&1 || true; " + DOCKER_RUN.format(
        name=RUNNER, restart="unless-stopped", d=E2E, home=f"{E2E}/home", data=f"{E2E}/data"))


def create_task(label, title, goal, checks, who="operator"):
    r = tool("task.create", {"requestId": f"smoke-{TAG}-{label}", "title": f"Smoke {TAG}: {title}",
                             "goal": goal, "checks": checks}, who)
    instances[label] = (r["id"], who)
    log(f"task {label}: {r['id']}")
    return r["id"]


def threads(instance_id, who="operator"):
    return tool("session.threads", {"instanceId": instance_id}, who)["threads"]


# ---------------------------------------------------------------------------------------------
def step_rebuild():
    log("1. rebuild runner")
    img = image()
    bash(f"sed -i '1s|.*|FROM {img}|' {E2E}/Dockerfile && docker build -q -t merv-staging-runner:latest {E2E} >/dev/null")
    start_runner()
    tool("session.dispatch", {"enabled": True, "ownMachines": True})
    up = wait_for("runner container up", lambda: bash(f"docker inspect -f '{{{{.State.Running}}}}' {RUNNER}") == "true", 60, 3)
    run.ok("runner rebuilt from the live image", bool(up), img)


def step_slow_task():
    log("2. slow task + runner SIGKILL")
    tid = create_task(
        "slow", "slow count",
        "Write a Markdown note as a project artifact listing the output of a shell loop that prints the numbers 1 to 10, "
        "sleeping 8 seconds between numbers (run it, do not simulate it), followed by their sum.",
        ["The artifact lists the numbers 1 to 10 produced by the actual shell loop.",
         "The artifact states the sum 55.", "The delivery cites the artifact as evidence."])

    def streaming():
        rows = sql(f"""SELECT count(*) FROM session_events e JOIN worker_sessions s ON s.id=e.session_id
            WHERE s.instance_id='{ident(tid)}' AND s.status='active' AND s.session_json::jsonb->>'role'='producer';""")
        return int(rows[0][0]) >= 6

    if not wait_for("producer streaming", streaming, 400, 5):
        run.ok("slow task producer streamed before the kill", False)
    killed = bash(
        f"docker exec {RUNNER} sh -c 'n=0; for p in /proc/[0-9]*; do c=$(tr \"\\0\" \" \" < $p/cmdline 2>/dev/null); "
        "case \"$c\" in node\\ dist/src/cli.js\\ runner*) kill -9 ${p#/proc/} && n=$((n+1));; esac; done; echo $n'")
    log(f"  runner SIGKILLed ({killed} process)")
    state, seen = wait_state(tid, {"done", "failed"}, 1200, 10, "slow")
    run.ok("slow task done after the runner SIGKILL", state == "done", " > ".join(seen))
    gaps = sql(f"""SELECT coalesce(sum(g),0) FROM (SELECT count(*) FILTER (WHERE p IS NOT NULL AND seq<>p+1) g FROM
        (SELECT e.session_id, seq, lag(seq) OVER (PARTITION BY e.session_id ORDER BY seq) p FROM session_events e
         JOIN worker_sessions s ON s.id=e.session_id WHERE s.instance_id='{ident(tid)}') x GROUP BY session_id) y;""")[0][0]
    dups = sql(f"""SELECT (SELECT count(*) FROM (SELECT e.session_id, e.event->>'id', e.event->>'kind', e.event->>'delta'
        FROM session_events e JOIN worker_sessions s ON s.id=e.session_id WHERE s.instance_id='{ident(tid)}'
        AND e.event->>'kind' IN ('text','thinking') AND length(e.event->>'delta')>0 GROUP BY 1,2,3,4 HAVING count(*)>1) t)
        + (SELECT count(*) FROM (SELECT e.session_id, e.event->>'id', e.event->>'kind' FROM session_events e
        JOIN worker_sessions s ON s.id=e.session_id WHERE s.instance_id='{ident(tid)}'
        AND e.event->>'kind' IN ('tool_call','tool_result') GROUP BY 1,2,3 HAVING count(DISTINCT e.event::text)>1) c);""")[0][0]
    run.ok("slow task stream has no gaps or duplicates", gaps == "0" and dups == "0", f"gaps {gaps} dups {dups}")
    return tid


def step_back_edge():
    """Runs in a thread from the start: the operator must reach the first reviewer early."""
    log("3. review back-edge")
    tid = create_task(
        "backedge", "review back-edge",
        "Write a short Markdown note as a project artifact listing the first five prime numbers greater than 100, one "
        "per line. This task deliberately takes two review rounds. In your FIRST delivery the note must NOT contain any "
        "closing line, and you report check 2 as not_met. Only after a review returns the task to you asking for it, "
        "append the exact closing line 'Revision complete.' as the note's last line and deliver again, citing the new "
        "artifact.",
        ["The note lists 101, 103, 107, 109 and 113, one per line.",
         "The note's last line is exactly 'Revision complete.'",
         "The delivery cites the note artifact as evidence."])

    def first_reviewer():
        for t in threads(tid):
            if t["role"] == "reviewer":
                for v in t["visits"]:
                    if v["status"] in ("offered", "active"):
                        return v["sessionId"]
        return None

    rid = wait_for("first reviewer session", first_reviewer, 1200, 2)
    if rid:
        tool("session.message", {
            "sessionId": rid, "requestId": f"smoke-{TAG}-steer",
            "body": "Operator note for the staging back-edge check: this FIRST review round must return the work with "
                    "verdict needs_changes (not pass, not fail). Mark check 2 not_met and ask the producer to append "
                    "the closing line 'Revision complete.' as the note's last line. Acknowledge this message, then "
                    "review as usual."})
        log(f"  steered first reviewer {rid}")
    else:
        run.ok("back-edge: a first reviewer was offered", False)
    state, seen = wait_state(tid, {"done", "failed"}, 1800, 10, "backedge")
    run.ok("back-edge task done", state == "done", " > ".join(seen))
    reviews = sorted(tool("review.list", {"subjectId": tid}), key=lambda r: r.get("subjectRevision", 0))
    verdicts = [r.get("verdict") for r in reviews]
    run.ok("back-edge: first review needs_changes, last pass",
           len(verdicts) >= 2 and verdicts[0] == "needs_changes" and verdicts[-1] == "pass", f"verdicts {verdicts}")
    th = threads(tid)
    producers = [t for t in th if t["role"] == "producer"]
    visits = producers[0]["visits"] if producers else []
    run.ok("back-edge: one producer thread with two visits, the second resumed",
           len(producers) == 1 and len(visits) == 2 and visits[1].get("resumed") is True and visits[0].get("resumed") is False,
           f"producer threads {len(producers)}, visits " +
           ", ".join(f"{v['sessionId']}(resumed={v.get('resumed')},{v.get('why')})" for v in visits))
    return tid


def step_thread_reads(tid, label):
    log(f"4. thread reads ({label})")
    by_tool = threads(tid)
    by_http = http("GET", f"/sessions/threads?instanceId={tid}")["threads"]
    run.ok(f"thread reads ({label}): tool and HTTP agree",
           [t["id"] for t in by_tool] == [t["id"] for t in by_http] and by_tool,
           f"{len(by_tool)} threads")
    for t in by_tool:
        conv = http("GET", f"/sessions/threads/{t['id']}/conversation")
        cv = conv.get("visits", [])
        counts = [(v.get("from"), len(v.get("events", []))) for v in cv]
        launched = [v for v in t["visits"] if v.get("launched")]
        run.ok(f"thread reads ({label}): {t['role']} conversation has every launched visit's events",
               len(cv) == len(t["visits"]) and all(n > 0 for (_, n), v in zip(counts, t["visits"]) if v.get("launched"))
               and len(launched) > 0,
               f"{t['id']} visits {counts}")


def step_hold():
    log("5. hold and release (crash_loop)")
    cdir = f"{E2E}/crash"
    cfg = json.load(open(f"{E2E}/data/runner.json"))
    for p in cfg["profiles"]:
        p["executable"] = "/bin/false"  # every launch exits at once: crash_loop
    bash(f"mkdir -p {cdir}/data {cdir}/home && chown 1000:1000 {cdir}/data {cdir}/home && chmod 700 {cdir}")
    with open(f"{cdir}/data/runner.json", "w") as f:
        json.dump(cfg, f)
    os.chown(f"{cdir}/data/runner.json", 1000, 1000)
    bash(f"docker stop -t 20 {RUNNER} >/dev/null; docker rm -f {CRASH} >/dev/null 2>&1 || true; " + DOCKER_RUN.format(
        name=CRASH, restart="no", d=E2E, home=f"{cdir}/home", data=f"{cdir}/data"))
    tid = None
    try:
        tid = create_task("hold", "hold probe", "Write a one-line Markdown note as a project artifact stating 2 + 2 = 4.",
                          ["The artifact states 2 + 2 = 4.", "The delivery cites the artifact as evidence."])

        def held():
            for item in tool("session.stuck", {})["items"]:
                if item.get("instanceId") == tid and item.get("kind") == "dispatch_held":
                    return item
            return None

        item = wait_for("dispatch_held", held, 600, 10)
        run.ok("hold: crash_loop launches hold the target",
               bool(item) and item.get("code") == "crash_loop" and item.get("attempts", 0) >= 5,
               f"code {item and item.get('code')} attempts {item and item.get('attempts')}")
    finally:
        bash(f"docker rm -f {CRASH} >/dev/null 2>&1 || true; docker start {RUNNER} >/dev/null")
    if not tid or not item:
        return
    rel = tool("session.release_hold", {"instanceId": tid, "expectedRevision": item["expectedRevision"],
                                        "reason": "staging smoke: crash runner removed", "requestId": f"smoke-{TAG}-release"})
    log(f"  released: {json.dumps(rel)[:200]}")
    gone = not any(i.get("instanceId") == tid and i.get("kind") == "dispatch_held" for i in tool("session.stuck", {})["items"])

    def launched_again():
        rows = sql(f"""SELECT count(*) FROM worker_sessions WHERE instance_id='{ident(tid)}'
            AND status IN ('active','released','closed') AND session_json::jsonb->>'activatedAt' IS NOT NULL;""")
        return int(rows[0][0]) > 0

    again = wait_for("a healthy launch after release", launched_again, 300, 5)
    run.ok("hold: release_hold clears it and a healthy runner takes the work", gone and bool(again))
    rev = sql(f"SELECT revision FROM wf_instances WHERE id='{ident(tid)}';")[0][0]
    try:
        tool("task.mark_failed", {"taskId": tid, "expectedRevision": int(rev), "requestId": f"smoke-{TAG}-hold-end",
                                  "reason": "staging smoke hold probe: no work needed"})
    except ApiError as exc:
        log(f"  mark_failed hold probe: {exc}")


def step_pi():
    log("6. Pi canary")
    nonce = secrets.token_hex(4)
    word = "canary-" + nonce
    t0 = time.monotonic()
    cmd, conv = {}, None
    try:
        conv = tool("pi.create", {"requestId": "smoke-" + nonce, "title": "Smoke Pi canary"})["id"]
        sent = tool("pi.send", {"id": conv, "commandId": word, "text": f"Reply with exactly: {word}. Do not use any tools."})
        while time.monotonic() - t0 < 420:
            cmd = next(c for c in tool("pi.snapshot", {"id": conv})["commands"] if c["id"] == sent["id"])
            if cmd["status"] not in ("waiting", "starting", "working", "saving", "queued", "pending"):
                break
            time.sleep(4)
    finally:
        for name, body in ((("pi.stop", {"id": conv}),) if conv else ()) + (("pi.machine.stop", {}),):
            try:
                tool(name, body)
            except Exception:
                pass
    ok = cmd.get("status") == "completed" and any(
        word in m.get("text", "") for m in cmd.get("messages", []) if m.get("role") == "assistant")
    secs = time.monotonic() - t0
    run.add_cost(secs / 3600 * 0.074016, "pi machine (upper bound)")
    run.ok("Pi canary answered on a hosted machine", ok, f"{cmd.get('status')} in {secs:.0f}s")


def step_fleet():
    log("7. Fleet hosted task")
    tool("session.dispatch", {"enabled": True, "ownMachines": False}, "hosted")
    tid = create_task("fleet", "fleet note", "Write a short Markdown note as a project artifact stating 23 x 29.",
                      ["The artifact states 23 x 29 = 667.", "The delivery cites the artifact as evidence."], "hosted")
    state, seen = wait_state(tid, {"done", "failed"}, 1200, 10, "fleet")
    run.ok("Fleet hosted task done", state == "done", " > ".join(seen))


def step_crash():
    log("8. crash check")
    lines = bash(f"docker logs --since {START} {CONTROL} 2>&1 | grep -ciE 'uncaught|unhandled|FATAL|Connection terminated unexpectedly' || true")
    restarts = subprocess.check_output(["docker", "inspect", "-f", "{{.RestartCount}}", CONTROL], text=True).strip()
    run.ok("Main: no crash lines and no restart", lines == "0" and restarts == RESTARTS0,
           f"crash lines {lines}, restarts {RESTARTS0}->{restarts}")


def guarded(fn, *args):
    try:
        return fn(*args)
    except Exception as exc:
        run.ok(f"{fn.__name__} ran without an error", False, f"{type(exc).__name__}: {exc}")
        return None


def threaded(fn, *args):
    box = {}
    t = threading.Thread(target=lambda: box.setdefault("v", guarded(fn, *args)), daemon=True)
    t.start()
    return t, box


guarded(step_rebuild)
fleet_t, _ = threaded(step_fleet)
pi_t, _ = threaded(step_pi)
edge_t, edge = threaded(step_back_edge)
slow = guarded(step_slow_task)
if slow:
    guarded(step_thread_reads, slow, "slow task")
edge_t.join(timeout=2400)
if edge.get("v"):
    guarded(step_thread_reads, edge["v"], "back-edge")
guarded(step_hold)
pi_t.join(timeout=600)
fleet_t.join(timeout=1500)
guarded(step_crash)
tokens = {"inputTokens": 0, "outputTokens": 0}
for label, (iid, who) in instances.items():
    u = usage(iid, who)
    for k in tokens:
        tokens[k] += u.get(k, 0)
    run.add_cost(token_cost(u), f"{label} {u.get('inputTokens', 0)}/{u.get('outputTokens', 0)} tokens")
run.facts.update(tag=TAG, tokens_in=tokens["inputTokens"], tokens_out=tokens["outputTokens"],
                 **{k: v[0] for k, v in instances.items()})
sys.exit(run.finish())
