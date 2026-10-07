# T1 research loop: appended to stg.py and run on the staging VM by research-loop.sh.
# argv: [-, TAG, --project hosted|e2e]
#
# One small but real research flow, driven only by Merv's own tools and agents:
#  1. a task whose agent writes a tiny standard-library dataset script (data/make_dataset.py);
#  2. an experiment depending on it, whose design trains a logistic regression on that data
#     (under 2 minutes) on a rented Modal cpu-2 machine through the native Sandboxes connection;
#  3. design review, execution, results review: independent agents, as in production.
# Asserts structure only: the states reached in order, the reviews, the result artifact and its
# accuracy above a floor, Modal work recorded, and nothing stuck, held or still running.
# Training on Modal is BLOCKED, not FAIL, where the environment cannot give it: no connection, a
# connection the staging-compute account does not fund, Modal not offered to that payer (seen by
# the preflight, or reported by the agent). It FAILS only where Modal was offered and not used.
# A producer may end its visit with session.ask_owner; the script answers as the owner with
# session.message to its thread (at most 3 answers) and asserts the work moves on within 10 min.
# Hard caps: 45 minutes and $2 (model tokens estimated, plus Modal); past either the script ends
# the work (abandon / mark_failed / halt) and fails.
import urllib.parse
import uuid

argv = sys.argv[1:]
TAG = argv[0] if argv and not argv[0].startswith("--") else time.strftime("%H%M%S", time.gmtime())
WHO = "operator" if "--project" in argv and argv[argv.index("--project") + 1] == "e2e" else "hosted"
CAP_SECONDS = int(os.environ.get("STG_T1_CAP_SECONDS", 45 * 60))
CAP_USD = float(os.environ.get("STG_T1_CAP_USD", 2.0))
ACCURACY_FLOOR = 0.80
EXPERIMENT_PATH = ["planned", "design_review", "running", "experiment_review", "complete"]
ANSWER_CAP = 3
RESUME_SECONDS = 10 * 60
ANSWER_NO_SANDBOXES = ("Proceed on the workspace CPU and record machine='workspace'. This staging project has no "
                       "Sandboxes connection; the check reports that step separately.")
ANSWER_NO_MODAL = ("Proceed on the workspace CPU and record machine='workspace'. Modal is not offered to this "
                   "project's Sandboxes payer here; the check reports that step separately.")
# An agent's own report that its payer is not offered Modal (as `sandbox_options` says it).
MODAL_REFUSED = re.compile(r"modal[^.]*\bnot\b[^.]*\b(configured|offered|available|enabled)\b", re.I)
MODAL_STEP = "training on Modal through the Sandboxes tools"
ANSWER_DEFAULT = "Proceed with your best judgement within the experiment's caps; record any deviation in the report."
run = Run("research-loop")
run.facts["project"] = WHO
started = time.monotonic()


def rev(instance_id):
    rows = sql(f"SELECT revision FROM wf_instances WHERE id='{ident(instance_id)}';")
    return int(rows[0][0]) if rows else None


def live_sessions(ids):
    if not ids:
        return 0
    inl = ",".join(f"'{ident(i)}'" for i in ids)
    return int(sql(f"SELECT count(*) FROM worker_sessions WHERE instance_id IN ({inl}) AND status IN ('offered','active');")[0][0])


def stuck_for(ids):
    return [i for i in tool("session.stuck", {}, WHO)["items"] if i.get("instanceId") in ids]


def open_questions(ids):
    """Questions the loop's agents asked with session.ask_owner and nobody answered yet: (id, thread, instance, text).
    The agent_question blocker in session.stuck names no thread, so the thread comes from Sessions' own rows."""
    inl = ",".join(f"'{ident(i)}'" for i in ids)
    return sql("SELECT id, thread_id, instance_id, translate(left(question, 600), E'\\t\\n\\r', '   ') FROM session_questions "
               f"WHERE instance_id IN ({inl}) AND answered_at IS NULL ORDER BY _merv_rowid;")


def answer_for(question):
    if not MODAL and re.search(r"sandbox|machine", question, re.I):
        return ANSWER_NO_SANDBOXES
    return ANSWER_NO_MODAL if MODAL and MODAL_REFUSED.search(question) else ANSWER_DEFAULT


def staging_compute():
    """The staging-compute account through its consumer token: its account id (where the token file,
    STG_COMPUTE_ACCOUNT_ID or /v1/auth/me names it) and the Modal offers it may rent now."""
    sbx = json.load(open(f"{E2E}/sandboxes-staging-compute.json"))  # never printed

    def get(path, **query):
        req = urllib.request.Request(f"{sbx['url']}/v1{path}" + ("?" + urllib.parse.urlencode(query) if query else ""),
                                     headers={"Authorization": "Bearer " + sbx["token"]})
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read() or b"{}")
    me = get("/auth/me")
    account = (os.environ.get("STG_COMPUTE_ACCOUNT_ID") or sbx.get("accountId") or sbx.get("account_id")
               or me.get("account_id") or me.get("accountId"))
    return account, {o.get("offer_id") for o in get("/options", provider="modal").get("offers", [])}


def modal_blocker(conn):
    """Why this environment cannot give the agent Modal, or None when it can."""
    if not conn.get("connected"):
        return (f"{project} has no Sandboxes connection (GET /sandboxes/connection: connected=false); connecting "
                "needs a signed-in human's consent at sandboxes.rapidreview.io with credentials = staging-compute")
    try:
        account, offers = staging_compute()
    except Exception as exc:  # the check of the environment failed, not the code under test
        return f"the staging-compute account could not be read: {exc}"
    if account and conn.get("accountId") != account:
        return (f"the connection is funded by account {conn.get('accountId')} (funding={conn.get('funding')}), "
                f"not the staging-compute account {account}")
    if "cpu-2:modal" not in offers:
        return "Modal cpu-2 is not offered to the staging-compute account (GET /v1/options?provider=modal)"
    return None


# --- preflight -------------------------------------------------------------------------------
conn = http("GET", "/sandboxes/connection", who=WHO)
project = json.load(open(f"{E2E}/{KEYS[WHO]}"))["projectId"]
log(f"project {project} ({WHO}); Sandboxes connected={conn.get('connected')} funding={conn.get('funding')} "
    f"account={conn.get('accountId')}")
blocker = modal_blocker(conn)
MODAL = blocker is None
if blocker:
    run.blocked(MODAL_STEP, blocker)
tool("session.dispatch", {"enabled": True, "ownMachines": WHO == "operator"}, WHO)

# --- the work --------------------------------------------------------------------------------
task = tool("task.create", {
    "requestId": f"t1-{TAG}-data", "title": f"T1 {TAG}: dataset script",
    "goal": "Add data/make_dataset.py to the repository: a Python 3 script using only the standard library that writes "
            "data/dataset.csv with the header line x1,x2,x3,x4,x5,label and 2000 rows of synthetic binary "
            "classification data generated with random.Random(7): each x_i is rng.gauss(0, 1), and label is 1 when "
            "1.5*x1 - 2.0*x2 + 0.5*x3 + rng.gauss(0, 0.5) > 0, else 0. Run it once to check it, commit the script "
            "(not the CSV) and deliver.",
    "checks": ["The delivered commit adds data/make_dataset.py, which imports only the Python standard library.",
               "Running python3 data/make_dataset.py writes data/dataset.csv with the header x1,x2,x3,x4,x5,label and "
               "exactly 2000 data rows.",
               "Both label values 0 and 1 occur in the generated data."]}, WHO)["id"]
log(f"task {task}")
compute = (
    "Compute: run the training as a job on ONE rented Modal cpu-2 machine (offer cpu-2:modal) through the native "
    "Sandboxes MCP connection, with a lease of at most 20 minutes, and release the machine as soon as the job is done. "
    "Record the sandbox id in the result."
    if MODAL else
    "Compute: Modal is not available to this project here, so run the training in your own workspace; it takes "
    "seconds. Record 'workspace' as the machine in the result.")
exp = tool("experiment.create", {
    "requestId": f"t1-{TAG}-exp", "name": f"stg-t1-logreg-{TAG}", "dependsOn": [task],
    "intent": "Measure how well a plain logistic regression separates the synthetic dataset produced by "
              "data/make_dataset.py, as a small end-to-end staging check of the research loop.",
    "details": "Staging check T1. Data: data/make_dataset.py from the prerequisite task (standard library only). "
               "Method: logistic regression trained by full-batch gradient descent in pure Python (standard library "
               "only; numpy may be absent), an 80/20 split shuffled with random.Random(7), at most 300 epochs, "
               "learning rate 0.5; report held-out accuracy. Expected accuracy is at least 0.85. "
               # The results review then gets the writer's untracked files copied into its checkout
               # on the same work host: the path that ended every review launch with exit 70.
               "Regenerate data/dataset.csv with the script and leave it uncommitted and untracked: commit "
               "only code and results. " + compute + " "
               "Keep it small: no hyperparameter search and no further experiments. Results: attach ONE JSON result at "
               "path results/metrics.json with role result: {\"accuracy\": float, \"n_train\": int, \"n_test\": int, "
               "\"epochs\": int, \"seconds\": float, \"machine\": string}."}, WHO)
exp_id = exp.get("id") or exp.get("experiment", {}).get("id")
log(f"experiment {exp_id}")
run.facts.update(task=task, experiment=exp_id)
try:
    tool("usage.set_budget", {"instanceId": exp_id, "maxWallMinutes": 120}, WHO)  # Merv-side backstop
except ApiError as exc:
    log(f"  usage.set_budget: {exc}")

# --- watch until settled or capped -----------------------------------------------------------
seen = {task: [], exp_id: []}
reached = {}
stuck_seen = {}
answered = {}  # thread -> question ids answered there
pending = {}  # instance -> {"at", "state", "thread", "n"}: answered, not yet moved on
answers = 0
asked = []  # every question text the agents asked
reason = None


def label(iid):
    return "task" if iid == task else "experiment"


def resume_evidence(iid, p):
    left_open = [q[0] for q in open_questions([iid])]
    blockers = [(i["kind"], i.get("code")) for i in stuck_for({iid})]
    return (f"{label(iid)} {iid} still {state_of(iid)} {round(time.monotonic() - p['at'])}s after answer {p['n']} "
            f"on thread {p['thread']}; open questions {left_open}, live sessions {live_sessions([iid])}, stuck {blockers}")


while True:
    for iid in (task, exp_id):
        s = state_of(iid)
        if s and (not seen[iid] or seen[iid][-1] != s):
            seen[iid].append(s)
            reached[f"{'task' if iid == task else 'exp'}:{s}"] = round(time.monotonic() - started)
            log(f"  {'task' if iid == task else 'experiment'} -> {s} at {round(time.monotonic() - started)}s")
    for item in stuck_for({task, exp_id}):
        key = (item["instanceId"], item["kind"], item.get("code"))
        if key not in stuck_seen:
            stuck_seen[key] = item
            log(f"  stuck: {item['kind']} {item.get('code')} on {item['instanceId']}: {str(item.get('why'))[:200]}")
    # --- answer the agents' questions as the owner, one message per thread ---
    threads = {}
    for qid, thread, iid, text in open_questions([task, exp_id]):
        if qid not in answered.get(thread, set()):
            threads.setdefault(thread, (iid, text, []))[2].append(qid)
    for thread, (iid, text, qids) in threads.items():
        if answers >= ANSWER_CAP:
            reason = f"agent question cap reached ({ANSWER_CAP} answers): {text[:200]}"
            break
        answers += 1
        asked.append(text)
        body = answer_for(text)
        log(f"  question on {label(iid)} {iid} (thread {thread}): {text[:200]}")
        try:
            tool("session.message", {"threadId": thread, "body": body, "requestId": f"t1-{TAG}-answer-{answers}"}, WHO)
        except ApiError as exc:
            run.ok("agent question answered and the work resumed", False, f"session.message to {thread}: {exc}")
            answered.setdefault(thread, set()).update(qids)
            continue
        answered.setdefault(thread, set()).update(qids)
        kind = {ANSWER_NO_SANDBOXES: "no Sandboxes", ANSWER_NO_MODAL: "no Modal"}.get(body, "default")
        log(f"  answered ({kind}): {body}")
        pending[iid] = {"at": time.monotonic(), "state": state_of(iid), "thread": thread, "n": answers}
    if reason:
        break
    # --- the answered work must move on within RESUME_SECONDS ---
    for iid, p in list(pending.items()):
        now = state_of(iid)
        if now != p["state"]:
            run.ok("agent question answered and the work resumed", True,
                   f"{label(iid)} {p['state']} > {now} {round(time.monotonic() - p['at'])}s after answer {p['n']}")
            del pending[iid]
        elif time.monotonic() - p["at"] > RESUME_SECONDS:
            run.ok("agent question answered and the work resumed", False, resume_evidence(iid, p))
            del pending[iid]
    u = usage(exp_id, WHO)
    spent = token_cost(u)
    if seen[exp_id] and seen[exp_id][-1] in ("complete", "abandoned", "failed"):
        break
    if seen[task] and seen[task][-1] == "failed":
        reason = "the dataset task failed"
        break
    if time.monotonic() - started > CAP_SECONDS:
        reason = f"time cap {CAP_SECONDS}s reached"
        break
    if spent > CAP_USD:
        reason = f"cost cap ${CAP_USD} reached (est ${spent:.2f})"
        break
    time.sleep(15)

for iid, p in pending.items():  # the loop ended before an answered item was seen moving on
    now = state_of(iid)
    run.ok("agent question answered and the work resumed", now != p["state"],
           f"{label(iid)} {p['state']} > {now} after answer {p['n']}" if now != p["state"] else resume_evidence(iid, p))
if reason:
    log(f"ending the work: {reason}")
    for iid, end in ((exp_id, "experiment"), (task, "task")):
        if state_of(iid) in ("complete", "done", "abandoned", "failed"):
            continue
        try:
            if end == "experiment":
                tool("experiment.transition", {"experimentId": iid, "transition": "abandon", "expectedRevision": rev(iid),
                                               "requestId": f"t1-{TAG}-abandon", "evidence": {"reason": "staging T1: " + reason}}, WHO)
            else:
                tool("task.mark_failed", {"taskId": iid, "expectedRevision": rev(iid), "requestId": f"t1-{TAG}-fail",
                                          "reason": "staging T1: " + reason}, WHO)
        except ApiError as exc:
            log(f"  could not end {iid}: {exc}")
    for row in sql(f"SELECT id FROM worker_sessions WHERE instance_id IN ('{ident(task)}','{ident(exp_id)}') AND status IN ('offered','active');"):
        try:
            tool("session.halt", {"sessionId": row[0], "reason": "staging_t1_cap"}, WHO)
        except ApiError as exc:
            log(f"  halt {row[0]}: {exc}")
    run.ok("finished inside the caps", False, reason)

# --- assertions (structure, never wording) ---------------------------------------------------
elapsed = time.monotonic() - started
run.ok("dataset task done", seen[task][-1:] == ["done"], " > ".join(seen[task]))
path = [s for s in seen[exp_id] if s in EXPERIMENT_PATH]
run.ok("experiment reached planned > design_review > running > experiment_review > complete",
       path[-1:] == ["complete"] and all(s in path for s in EXPERIMENT_PATH), " > ".join(seen[exp_id]))
state = tool("experiment.get_state", {"experimentId": exp_id}, WHO)
reviews = tool("review.list", {"subjectId": exp_id}, WHO)
verdicts = [r.get("verdict") for r in sorted(reviews, key=lambda r: r.get("subjectRevision", 0))]
run.ok("design and results reviewed by independent agents", len(reviews) >= 2 and verdicts[-1:] == ["pass"],
       f"verdicts {verdicts}")
results = [e for e in state.get("evidence", []) if e.get("role") == "result" and e.get("current")]
metrics = None
for e in results:
    try:
        content = tool("artifact.read", {"artifactId": e["artifactId"]}, WHO).get("content", "")
        doc = json.loads(content)
        if isinstance(doc, dict) and "accuracy" in doc:
            metrics = doc
            break
    except Exception as exc:
        log(f"  result {e.get('artifactId')}: {exc}")
run.ok("result artifact attached with an accuracy", metrics is not None,
       f"{len(results)} result files" + (f", {e.get('path')}" if results else ""))
acc = float(metrics.get("accuracy", 0)) if metrics else 0.0
run.facts["accuracy"] = round(acc, 4)
run.ok(f"held-out accuracy above {ACCURACY_FLOOR}", acc >= ACCURACY_FLOOR, f"accuracy {acc:.4f} machine {metrics and metrics.get('machine')}")
if MODAL:
    works = int(sql(f"SELECT count(*) FROM sandbox_native_work w WHERE row_to_json(w)::text LIKE '%{ident(exp_id)}%';")[0][0])
    used = works > 0 and "sbx_" in str(metrics and metrics.get("machine"))
    refused = [q for q in asked if MODAL_REFUSED.search(q)]
    if not used and refused:  # its payer was not offered Modal: the environment, not the code
        run.blocked(MODAL_STEP, f"the agent reported Modal not offered to its payer: {refused[0][:300]}")
    else:
        run.ok("training ran on Modal through the Sandboxes connection", used,
               f"native work rows {works}, machine {metrics and metrics.get('machine')}")
# A question seen and answered is not stuck work; one still open at the end is.
asking = {q[2] for q in open_questions([task, exp_id])}
left = [i for i in stuck_for({task, exp_id}) if i.get("code") != "agent_question" or i["instanceId"] in asking]
run.ok("nothing stuck or held at the end", not left and not any(k[1] == "dispatch_held" for k in stuck_seen),
       f"now {[(i['kind'], i.get('code')) for i in left]}, seen {[k[1:] for k in stuck_seen]}")
run.ok("no session still running", live_sessions([task, exp_id]) == 0)
u = usage(exp_id, WHO)
run.add_cost(token_cost(u), f"model tokens {u.get('inputTokens', 0)} in / {u.get('outputTokens', 0)} out over {u.get('sessions')} sessions")
run.ok(f"inside the caps ({CAP_SECONDS // 60} min, ${CAP_USD})", elapsed <= CAP_SECONDS and run.cost <= CAP_USD,
       f"{elapsed / 60:.1f} min, est ${run.cost:.2f}")
run.facts.update(tag=TAG, questions_answered=answers, sessions=u.get("sessions"), tokens_in=u.get("inputTokens"), tokens_out=u.get("outputTokens"),
                 reached=";".join(f"{k}@{v}s" for k, v in reached.items()))
sys.exit(run.finish())
