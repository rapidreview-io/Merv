# Support separation: contracts and rules (wave 1)

Repo: the Merv monorepo. Backend package lives at `merv/src/merv` (brain, client, shared).
You are working in a dedicated git worktree on your own branch; the path is in your prompt.
Never touch the shared checkout at `/Users/guraltoo/Documents/dev/proj/experiments/Merv`
and never touch another agent's worktree. Never push.

## The target architecture (founder rulings, settled)

Three layers:

1. **Research**: `brain/research_core`, `brain/workflows`, `brain/application` (except
   `maintenance.py`), `brain/literature`, the research routers
   (`surface/transport/api/{experiments,reflections,claims,reviews,tasks,views,sandboxes}.py`),
   `surface/experiment_figure.py`, `surface/workflow_knowledge.py`.
2. **Support**: `brain/artifacts`, `brain/feed`, `brain/agent_sessions`, `brain/kernel`
   (state store, events, tool-call ledger), `application/maintenance.py`, all remaining
   `surface/**` (auth, OAuth, project keys, runner pairing, agent identity, telemetry,
   tool dispatcher, MCP transport, gateway, http policy, generic routers, config,
   composition), the client (`client/**`: runner, CLI, harness), `shared/**`, deploy.
3. **ML infrastructure**: `brain/infrastructure/**` (adapter to the external
   merv-sandboxes service). Object storage now lives in merv-sandboxes.

`brain/mlflow/**` is frozen. Do not edit any file under it. If an import in
`brain/application/mlflow.py` has to change because a symbol it imports is removed,
make the smallest possible edit there and list it in your report.

## Definition of "support-clean" (this is what you are enforcing)

- Support code contains **no research logic**. It never branches on, joins, or names
  experiments, tasks, reflections, consolidation, reviews, reviewers, claims, lenses,
  candidates. Storing and echoing an opaque id or label that a packet supplied is fine;
  interpreting its value is not.
- Support imports only `brain/kernel` and `merv.shared`. Anything support needs from
  research is a `Protocol` **declared in the support module** and implemented by
  research or application, wired in `surface/surface.py`.
- Support never queries research tables: `experiments`, `tasks`, `reflections`,
  `claims`, `reviews`, `review_requests`, `review_sessions`, `consolidation_*`,
  `reflection_*`, `experiment_claims`, `project_candidates`.
- Research declares; support enforces. When support needs to know "what may this
  session do", the answer is data that the workflow node declared, carried in the
  packet, never a kind switch in support.

## Working rules

- Python: `/Users/guraltoo/Documents/dev/proj/experiments/Merv-support-separation/merv/.venv/bin/python`
  (already has every dependency; it is created once the baseline run finishes).
- Tests, run from `<your worktree>/merv`:
  `PYTHONPATH=src <python above> -m unittest discover -s tests`
  Structure tests: `PYTHONPATH=src <python> -m unittest discover -s tests/structure -t .`
  Baseline result at HEAD is in
  `/private/tmp/claude-501/-Users-guraltoo-Documents-dev-proj-experiments-Merv/cc72a77d-d666-46b8-af82-3bbd2e98143f/scratchpad/baseline_tests.log`;
  any failure that is already in the baseline is not yours.
- The structure tests in `merv/tests/structure/` enforce the module law. Update
  `test_module_boundaries.py` (component map, allowed edges, `TABLE_OWNERS`) only when
  the change is the intended new ownership, and say exactly what you changed and why.
- Component design notes (`brain/<component>/<component>.md`, `surface/surface.md`,
  `application/application.md`, `workflows/workflows.md`) must stay accurate and under
  100 lines; their header comment tells you when to update them.
- Do not edit `research_state_ui/**`. If a route or response shape you must change
  would break the UI, keep the old shape working and report it.
- Commit as you go, with explicit paths (`git add <paths>`; never `git add -A`).
  Imperative subject line, no prefix, wrapped body explaining why. End every commit
  message with the trailer line:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Prefer deleting over adapting. No compatibility shims unless the spec asks for one.
- Final report (your last message) must contain: files changed and why; every contract
  decision you made that the spec left open; tests run and their result; tests you
  changed deliberately and why; anything left undone; open questions.

---

## Contract A: node-declared execution policy

Owners: `execution-brain` (brain side) and `execution-runner` (client side). The two work
in parallel against this exact contract; do not deviate from field names.

### A.1 Declaration (research-owned, in `brain/workflows/graph.py`)

Replace `Node.read_only: bool` and `Node.workspace: str` with one `execution` field:

```python
@dataclass(frozen=True, slots=True)
class Scope:
    field: str                      # argument name; dotted for nested ("attach_to.target_id")
    source: str                     # "instance" | "reference:<kind>"  (id of the brief Reference of that kind)
    tools: tuple[str, ...] = ()     # empty: applies to every `mutating` tool that carries the field

@dataclass(frozen=True, slots=True)
class Workspace:
    mode: str = "persistent"        # "none" | "ephemeral" | "persistent"
    namespace: str = "workflows"    # opaque path/branch segment ("experiments", "consolidations", "reviews")
    base: str = "central"           # "central" | "reference:<kind>" (base sha from the brief Reference of that kind)
    per_base: bool = False          # persistent branch keyed by instance AND base sha (True for consolidation)
    retain: bool = True             # keep branch/worktree when the session ends
    advances_central: bool = False  # this node's accepted work may advance the central ref

@dataclass(frozen=True, slots=True)
class Execution:
    read_only: bool = False
    tools: frozenset[str] = frozenset()     # node-specific tools beyond the support baseline
    mutating: frozenset[str] = frozenset()  # subset of tools whose calls must satisfy `scope`
    scope: tuple[Scope, ...] = ()
    sandbox: bool = False                   # sandbox.* tools permitted
    workspace: Workspace = Workspace()
```

Every node in `workflows/definitions/*.py` declares its `Execution`. Reference points:
- experiment `planned`/`running`: tools = the experiment tool set now in
  `AGENT_EXPERIMENT_SESSION_TOOLS`, minus the generic baseline; mutating =
  {experiment.transition, experiment.exhibit, mlflow.finalize_run} ∪ sandbox.*;
  scope = (Scope("experiment_id", "instance"),); sandbox = True;
  workspace = Workspace(namespace="experiments").
- experiment `design_review`/`experiment_review`, task `in_review`, reflection
  `reflection_review`/`consolidation_review`: read_only = True; tools = today's review
  set minus baseline; scope = (Scope("review_request_id", "reference:review_request",
  tools=("review.start", "review.submit")),); workspace = Workspace(mode="ephemeral",
  namespace="reviews", base="reference:code", retain=False).
- reflection `consolidating`: tools = today's consolidation set minus baseline;
  mutating = {consolidation.submit}; scope = (Scope("reflection_id", "instance"),);
  workspace = Workspace(namespace="consolidations", base="reference:code",
  per_base=True, advances_central=True).
- task `in_progress`: mirror the experiment node without sandbox unless tasks use it today.
- Nodes with no agent keep `Execution()`.

Branch and worktree names must stay what they are today for experiments and
consolidations (`merv/experiments/<project>/<id>`, `merv/consolidations/<project>/<id>/<base12>`);
that is why `namespace` exists.

### A.2 Packet (research-owned, `workflows/runtime.py::_assignment`)

`execution` in the assignment packet becomes the JSON form of `Execution`:

```json
"execution": {
  "read_only": false,
  "tools": ["experiment.transition", "..."],
  "mutating": ["experiment.transition", "..."],
  "scope": [{"field": "experiment_id", "source": "instance", "tools": []}],
  "sandbox": true,
  "workspace": {"mode": "persistent", "namespace": "experiments", "base": "central",
                "per_base": false, "retain": true, "advances_central": false}
}
```

`tools` carries only node-specific tools; the support baseline is added by the gateway.
The packet keeps `role`, `label`, `brief`, `references`, `handoff` and the public
workflow view. `references` entries are `{kind, id, label}`; kinds used by the contract
are `"code"` (a git sha) and `"review_request"`.

### A.3 Support baseline (support-owned, `surface/transport/http_policy.py`)

Replace the three per-kind sets and the two workflow sets with:
- `SESSION_READ_BASELINE`: agent.hello, project, project.get, project.list,
  workflow.status_and_next, workflow.catalog, workflow.assignment, workflow.history,
  artifact.read, feed.list, storage.find, storage.fetch.
- `SESSION_WRITE_BASELINE` (added when not read_only): artifact.upload, artifact.attach,
  feed.post, feed.register, storage.submit, workflow.transition.
Effective allowlist = baseline(read_only) ∪ execution.tools.

### A.4 Gateway (support, `transport/api/gateway.py`)

Delete the kind-based path (`authorize_agent_session` branch using
`AGENT_*_SESSION_TOOLS`). `_authorize_workflow_session` becomes the only path and reads
the stored `execution` and `references` of the session:
- tool must be in the effective allowlist;
- `workflow.transition` must target the leased instance and use the leased revision
  (generic, keep);
- for each `Scope`, when the tool is in `mutating` (or in `scope.tools` when given) and
  the argument is present, it must equal the resolved source (instance id, or the id of
  the reference of that kind); the check also applies to `attach_to.*` for
  `artifact.upload` by the dotted-field rule;
- `sandbox.*` allowed only when `execution.sandbox`.
No tool name, id field name, or workflow name is hardcoded in the gateway beyond
`workflow.transition`, `artifact.upload`, `sandbox.` and the baseline sets.

### A.5 Agent sessions (support, `brain/agent_sessions`)

- Sessions store, verbatim from the packet: `workflow_instance_id`, `workflow_revision`,
  `role`, `label`, `execution` (JSON), `references` (JSON), plus opaque `target_type`
  (= the packet's workflow name) and `target_id` (= instance id) for UI links.
- Remove every enum over kinds/target types, every join on `experiments`/`reflections`,
  and the `terminal_experiment_statuses` constructor argument. Declare in
  `agent_sessions.py`:
  ```python
  class InstanceFacts(Protocol):
      def instance(self, *, project_id: str, instance_id: str) -> InstanceFact | None: ...
  # InstanceFact: instance_id, revision, terminal: bool, label: str
  ```
  implemented by the Workflows runtime and injected in `surface/surface.py`.
- Rename `experiment_workspaces` to `agent_workspaces` keyed by `(project_id,
  instance_id)` with a schema migration; `workspaces_for_experiments` becomes
  `workspaces(instance_ids)`. Application maps native ids to instance ids (today they
  are the same value).
- The `kind` the UI shows is derived in Application from `execution` (it already does
  this in `application.py`), never stored or read by agent sessions.

### A.6 Central advance (generic API replaces the consolidation routes)

Routes in `transport/api/agent_sessions.py` (support delivery, calling a Protocol
declared in that module and bound to Application methods in `surface.py`):
- `POST /api/projects/{pid}/agent-advances/prepare` body `{instance_id, runner_id}` →
  `{"advance": {advance_id, instance_id, revision, expected_sha, target_sha,
  sources: [{id, sha}]} | null}`
- `GET /api/projects/{pid}/agent-advances/pending` → same shape or null
- `POST /api/projects/{pid}/agent-advances/settle` body `{advance_id, runner_id,
  observed_sha, proposal_parents, diffstat, ancestry: {id: bool}, error}`
Keep the three old `/consolidation/*` routes as thin deprecated aliases that call the
same Protocol (delivery compatibility for runners in the field). Application keeps the
reflection-specific logic behind those Protocol methods; `sources[].id` is an opaque
lineage id to the runner (today an experiment id).

### A.7 Runner (support, `client/agent_runner.py`)

- `Claim` no longer has `experiment_id`/`kind` semantics. Fields: session_id, project_id,
  instance_id, target_type, target_id (opaque), role, label, execution (dict),
  references (list), review_request_id and source_sha derived from references by kind.
- `WorkspaceManager.prepare` is driven by `execution["workspace"]` only:
  mode none → `root/sessions/<project>/<session>`; ephemeral → detached worktree at the
  base sha under `root/<namespace>/<project>/<instance>/<session>`; persistent →
  branch `merv/<namespace>/<project>/<instance>` or `.../<base12>` when per_base, with
  the recorded-base checks kept. Cleanup honours `retain`.
- Central advance polls the generic routes of A.6 and keys `ancestry` by `sources[].id`.
- Trace `metadata.json` keeps its shape; values come from the packet.
- Nothing in the runner names experiments, reflections, consolidation, or reviewers.
  (The word "review" may survive only as the opaque `references[].kind` value
  "review_request".)

---

## Contract B: object storage moves to merv-sandboxes

Owner: `object-storage`.

Verified facts: merv-sandboxes (local checkout at
`/Users/guraltoo/Documents/dev/proj/experiments/merv-sandboxes/control/src/merv_sandboxes`)
already owns namespaced objects with name + auto-incremented version, kind, state, sha256,
size, content type, `expires_at` with `PATCH /storage/objects/{id}/retention` (null pins
permanently; shortening is a no-op), producer job links, manifests, per-namespace usage.
Merv's `brain/object_storage/` duplicates that ledger in `storage_objects` and registers
every byte object in sandboxes under name = sha256.

Do:
- Delete `brain/object_storage/`. Byte transfer stays in `infrastructure/storage.py`.
  Add an infrastructure-owned `RemoteObjects` root (new module in `brain/infrastructure/`)
  that the `storage.*` tools and the `/api/projects/{pid}/storage*` routes bind to:
  submit (create object in sandboxes using the display name and kind; sandboxes assigns
  the version), token completion, find/list, get, fetch (download presign), manage
  (pin = retention null; renew = extend by Merv's existing default retention window;
  delete). `unpin` cannot be expressed on sandboxes: return a 409 with a clear message
  and report it.
- Research association: new `research_core` module (`ResearchObjects`) linking an opaque
  object id to a target (experiment) with producing_run, source_uri, notes, and a
  metadata snapshot (name, version, kind, sha256, size_bytes, content_type, created_at)
  captured at completion, so `by_target(instance_ids)` needs no sandboxes round trip.
  Replace every `ObjectStorage.by_experiment` caller in application with it; the
  application `ProducedObjectCatalog` port is implemented by it. `ProducedObject`
  moves to research.
- Completion tokens (`storage_completion_tokens`) stay as delivery glue in the storage
  router; completing calls sandboxes then activates the association.
- Drop the per-project upload cap and the ledger `sweep_expired` from maintenance
  (sandboxes owns quota and expiry). A server-wide max-bytes constant may remain in the
  facade.
- `deploy/migrate_storage_ledger.py`: for each active `storage_objects` row, find the
  sandboxes object by sha256, write the research association, and report rows with no
  match. Sandboxes has no rename, so Merv display names/versions cannot be transferred;
  document that in the script header. Do not run it.
- Keep the MCP tool names and the UI route paths and response keys that the UI reads
  (list, get, download, pin, unpin, renew, delete); drop fields sandboxes cannot supply.
- Update `test_module_boundaries.py` (remove the object-storage component, fix
  `TABLE_OWNERS`), delete `tests/storage` tests that only exercised the ledger, and
  replace them with facade tests against a fake sandboxes client (see `tests/fakes.py`
  and `tests/infrastructure/test_remote_storage.py`).

---

## Contract C: feed refs and advisories

Owner: `feed-refs`.

- `feed/refs.py` hardcodes research id prefixes. Replace with a `RefVocabulary` that
  Feed receives at construction (a tuple of `(prefix, kind)`), supplied by research in
  `surface/surface.py`. Feed stores and renders refs opaquely.
- `FeedAdvisory.transition_advisory(project_id, experiment_id, event)` and the
  `experiment_*` message templates move out. Feed exposes a generic
  `advisory(project_id, ref, message)` that answers "nudge or not" from feed state only;
  the event→message mapping lives in `application/experiments/transition.py` (research).
- `AUTHOR_ROLES` / `ADOPTABLE_ROLES` name research roles; make them constructor
  arguments supplied at composition. Leave `surface/tools/feed_contracts.py` schemas
  alone this wave.
- Anything else in `feed/feed.py` that names experiments follows the same treatment.

---

## Contract D: shared research vocabulary moves into research

Owner: `shared-vocabulary`.

- `shared/artifact_roles.py` → `brain/workflows/definitions/artifact_roles.py`
  (definitions already import it; Research imports Workflows).
- `shared/content_summaries.py` → `brain/research_core/content_summaries.py`.
- `shared/path_utils.py` → `brain/research_core/paths.py`.
- `brain/kernel/utils.py` imports `safe_experiment_dirname` from shared; kernel is
  support and must not. Move that helper and its callers to research and remove the
  kernel dependency.
- Fix every importer (brain, tests, `tests/structure/test_service_layout.py`). The
  client and the UI do not use these modules; verify that and keep it so.
- Check `shared/storage_guidance.py` and `shared/client_config.py` for research words;
  neutralize wording only if it is logic, not prose.
