# Python → TypeScript backend feature audit

For the latest missing-capability inventory, read [Remaining parity](REMAINING_PARITY.md).
The historical tables below deliberately retain the original audit and must not be
read as the current implementation status.

## Current checkpoint — 2026-09-15

The following support, task-program, claim-record and experiment gaps from the original audit are now integrated:

- [Workflow guidance](WORKFLOW_GUIDANCE.md): one evaluated current gate, blockers,
  next action and input preflight shared by tools, Tasks, context and UI.
- [Loop limits, usage and budgets](BUDGETS_AND_LIMITS.md): three new tables, each with a
  native PostgreSQL twin using `BIGINT` integers: `wf_limit_grants` (workflows 5, no
  update or delete), `session_usage` (sessions 4, written once, no delete) and
  `session_budgets` (session_dispatch 3, mutable configuration). Every `SUM` over them is
  normalised to a number, because PostgreSQL returns `numeric` as text.
- [Task closure](TASK_CLOSURE.md): producer/operator withdrawal, safe review closure
  and explicit compatibility for older workflow versions.
- [Work-item prerequisites](WORK_ITEM_DEPENDENCIES.md): persistent dependency DAG,
  scoped completion rules and correctly placed task work/submission gates.
- [Structured delivery](STRUCTURED_TASK_EVIDENCE.md): generated briefs, numbered
  producer confirmations, pinned assessments, binary references and stable context replay.
- [Review assessments](REVIEW_ASSESSMENTS.md): synopsis, numbered findings with
  explicit waivers, structured observations, outcome precedence and revision feedback.
- [Explicit review return paths](REVIEW_RETURN_PATHS.md): optional domain-validated
  `returnTo`, immutable assessment storage, route-sensitive replay and atomic owner
  application. Tasks retains its fixed routes and refuses a supplied destination.
- [Workflow assignment and begin](WORKFLOW_ASSIGNMENT_PLAN.md): full read-only recipe
  previews, independent node admission and durable first activation with atomic rollback.
- [Actor credentials](ACTOR_CREDENTIALS.md): separate project-bound bearer records,
  expiry, metadata, staged self-rotation and request/transaction credential checks.
- [Shared identity and memberships](SHARED_IDENTITY.md): independent signed-user
  verification, project roles, membership epochs, explicit project selection,
  onboarding, membership UI and local ownership repair.
- [User-owned keys](USER_KEYS.md): project/account grants, current owner membership,
  human-only administration, atomic rotation, recursive revocation and domain
  event provenance. Key callers cannot mint independent actor credentials.
- [Fixed workflow policies](WORKFLOW_EXECUTION.md): version-pinned declarations,
  strict argument constraints, metadata-only admission, registration fences and
  a shared HTTP/MCP description path.
- [Session leases](SESSION_LEASES.md): MCP-only credentials, fixed discovery/dispatch,
  source and writer guards, metadata activation, durable ownership, heartbeat, expiry
  and successor context. Same-human independent producer/reviewer sessions work.

- [Runner control plane](RUNNER_CONTROL_PLANE.md): metadata-only eligible assignment selection, strict workspace declarations, source-bound runner presence and capacity, durable dispatch pause/halt, desired settings, retry backoff and optional Sessions UI.
- [Git workspaces](WORKSPACES.md): private repositories, persistent/ephemeral
  checkouts, exact commit references, durable ownership, stopped-worker WIP capture,
  immutable Session metadata and acknowledged cleanup across restart.
- [Code operations](CODE_OPERATIONS.md): live-session `code.commit` requests,
  `code.operation` status, a durable server queue and immutable operation receipts.
  The existing Runner executes fixed Git commits with private indexes, deterministic
  crash replay and checkout-owner fencing; no second machine provider is added.
- [Code proposals and review routing](CODE_PROPOSALS.md): immutable manifests bind
  original workers, successful receipts and verified artifact bytes in the domain
  transaction. Reviews owns the shared verdict tool and routes to one domain owner;
  existing Tasks keeps its response/replay/transition behavior. Production research
  proposals still require the actual experiment and reflection domains.
- [Claims](CLAIMS.md): project-scoped records and create/list/update tools, fixed public
  statement/scope, revision CAS, original request receipts, atomic attributed events
  and a role-aware UI. Claims requires only State and Scope; linked experiment
  evidence, belief-history UI and reviewed reflection text updates remain open.

- [Experiments](EXPERIMENTS.md): real records, attempts, approved-plan pinning,
  design/results review, exact immutable evidence rounds, metrics exhibits, retry
  and explicit return routes, owner terminal closure, recovery recipes and seven
  tools with a read-only UI. Exit guidance and submission share validation.
  The complete suite passes 610 tests; four native workers and actual browser
  acceptance also pass. See [the checkpoint](../verification/experiments.json).

The historical 490-test workspace-capture checkpoint is recorded in
[workspace verification](../verification/workspaces.json), including the prepared
Nisa integration. Code operations have separate verification in
[CODE_OPERATIONS.md](CODE_OPERATIONS.md); the earlier checkpoint does not prove the new path.
The [research program plan](RESEARCH_PROGRAM_PARITY_PLAN.md) records the next
dependency order: Claims is integrated and the production Experiment lifecycle
is integrated, followed by authoritative corpus queries, actual Reflection,
then reflection-owned consolidation/publication. The Claims integration checkpoint
passed 566 tests (13 Claims-specific). Two fresh native agents completed nine
successful MCP calls with no failures on synthetic claim records. The actual
built Claims page also passed browser checks for exact retry recovery, revision
conflicts, project switching and reader permissions through a local synthetic
fixture; no real shared-provider login was performed. See [Claims](CLAIMS.md)
for the exact implemented behavior, verification limits and remaining gaps.
The subsequent return-path prerequisite passed **574/574** full-suite tests,
**30/30** focused checks and **17/17** independent checks. Two fresh native
reviewers made seven successful MCP calls with no failures, read all three pinned
artifacts in full, and applied `fail → planned` and `needs_changes → running`.
The owner and producer evidence were synthetic, the approved plan was seeded,
and both destinations terminate that fixture. This does not establish production
Experiment creation, attempts or execution repair. The
[exact Experiment reference](EXPERIMENTS_PARITY_REFERENCE.md) is audited against
41 passing Python tests. The production Experiment implementation subsequently
passes 610 full-suite tests. Overall parity is still active. Current inventory is
43 plugins, 22 providers, 95 dependencies, 40 default/30 API-only entries and
44 domain tools (46 with UI).
These establish the task loop and local shared-account foundation, not full Python
parity. Three fresh agents completed the task/review loop with user-owned machine
keys across two restarts and two worker-key rotations: 40 calls, 37 successes and
three expected role refusals. Additional checks verified account rotation after
leaving the issuance project, recursive ancestor revocation, project confinement
and key/membership event attribution. See the
[user-key verification](../verification/user-keys.json). A further fresh-agent run
with fixed assignment declarations also passed 40 calls with the same success and
refusal totals. See [policy verification](../verification/workflow-execution.json)
and [its live-run limits](../verification/workflow-execution-live.json).
Two fresh leased agents under one source key completed 17 successful MCP calls
across two restarts. See [session verification](../verification/sessions.json).
The automatic-dispatch acceptance run also completed 17 successful calls with two fresh agents across two restarts, including default-off, replay and pause checks. See [dispatch verification](../verification/dispatch.json).
Native scratch processes and controller recovery now work through the independent
[machine Runner](MACHINE_RUNNER.md). Two fresh agents completed a task and review
with two shell commands and nine successful MCP calls; both process groups were
confirmed stopped. See [runner verification](../verification/runner.json).
Two fresh native agents also completed a synthetic Git handoff: the producer edited
a checkout, Runner captured a commit, and the verifier inspected that exact commit
in a read-only checkout. Three shell commands and two MCP calls succeeded; the
source repository was unchanged and both workers stopped. See
[workspace live evidence](../verification/workspaces-live.json). This proves the
generic lifecycle on one machine, not the research program or publication protocol.
The Code foundation separately passed 20 local Git tests and two synthetic
HTTP/MCP integrations, including live-worker commit receipts, actual Reviews
attribution, controller crash recovery, stale Git transactions and lost dispatch/
acknowledgment replies. These synthetic workers do not establish the new native
Code acceptance; its own status is recorded in the Code documentation.
Reflection-owned proposal commands, general merges, reviewed central publication, cross-machine Git object transport, pairing, telemetry, reflection/consolidation
programs, broader experiment orchestration and storage-provider parity remain open. Real shared Supabase/Nisa deployment and provider-backed browser login are not yet verified; the Claims browser checks use synthetic local credentials.
`experiment.plan` and `project.reflection` remain ordinary task recipes. The
separate Experiments provider now owns the production experiment lifecycle; the
Reflection program remains open.

The [identity/session sequence](IDENTITY_SESSION_PARITY_PLAN.md) now places the
reviewed code-proposal and publication protocol after the integrated live-commit
and final-capture foundations. A commit receipt preserves an exact observation;
it does not bind an approved proposal or advance central.
An operator actor credential remains separate from verified human membership.

Fable completed a generic user-key consultation without repository files;
its [source-independent review and dispositions](reviews/user-keys-fable-design.md)
do not substitute for the earlier private-source audit still pending approval.
The subsequent [fixed-policy consultation](reviews/workflow-execution-fable-design.md)
likewise used an abstract design question without private source. The Sessions
consultation was rejected by automatic approval review pending approval of its
specific architecture prompt; no Fable response exists for this wave. Independent
local source reviews and transport probes completed separately.

## Historical baseline before the completed slices above

**The TypeScript stack has a working task/evidence/review loop, but does not yet
have the Python backend's live workflow guidance or research orchestration.**
Matching component names do not establish matching capabilities. In particular,
`experiment.plan` and `project.reflection` are context recipes for ordinary tasks;
they do not implement the old experiment and reflection programs.

## 1. Does `workflow.status_and_next` exist?

**No. There is no equivalent computed guidance service or tool in TypeScript.**

| Question the agent needs answered         | Python backend                                                | Current TypeScript                                                  |
| ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| What state and revision is this work at?  | Status query                                                  | `task.get` does this                                                |
| What gate is holding up progress?         | `current_gate` from evaluated requirements                    | Missing                                                             |
| What is missing or invalid?               | Structured blockers, evidence validation and review facts     | Command errors on submission; no consolidated read query            |
| What should I do next?                    | `next_action` and available/blocked actions                   | Generic instructions in tool descriptions and context recipes       |
| Is work waiting for prerequisites?        | Dependency checks used for guidance, transitions and dispatch | Task prerequisites themselves are missing                           |
| What does the current assignment require? | Node-owned assignment, references and handoff instructions    | `task.context` builds a pinned package for work or a claimed review |
| Should this agent stop after the handoff? | Node execution policy and handoff guidance                    | Some recipe instructions; no node/session execution policy          |
| What needs attention across the project?  | Live work, reflection staleness and literature advice         | Separate task/review lists; no project orientation decision         |

Python's public tool accepts project scope, `task_id`, `experiment_id`, or a
generic `instance_id`. The workflow graph evaluates requirements and actions;
Application presents that decision with domain context. The compact agent view
avoids repeating evidence errors already represented as blockers. It does not
simply ask an LLM to invent a next step.

Sources: [tool contract][py-workflow-tools], [canonical evaluation][py-graph],
[status presentation][py-status], [project orientation][py-program].

TypeScript's Workflows contract currently describes states, edges, terminal
states and revisions. Task-specific evidence and permission checks live in task
commands. There is no registered requirement evaluator or shared decision object
that a status query, context recipe and future runner can consume.

Sources: [TypeScript contracts][ts-contracts], [Workflows][ts-workflows],
[task commands][ts-tasks], [task tools][ts-task-tools].

### This is distinct from the removed workflow tools

We removed `workflow.catalog`, `workflow.list`, `workflow.get` and
`workflow.history`. They exposed the generic workflow machinery. The useful
Python `workflow.status_and_next` feature had never been implemented in this
TypeScript stack. Removing the catalog was not the removal of a working guidance
feature. Restoring useful guidance does not require restoring all four tools.

The [existing integration test][ts-app-test] explicitly expects no `workflow.*`
tools. That expectation should change if a narrow guidance tool is introduced.

### Direct runtime check

Booted the current Cordis providers and all five native tool adapters against a
temporary database, without a network listener:

- The registry exposed 24 native domain tools.
- Calling `workflow.status_and_next` returned `unknown_tool`.
- `task.get` returned `in_progress`, a revision and evidence references.
- `task.context` returned a persisted recipe package.
- Submitting a delivery entered `in_review` and created a requested review.
- None of those responses contained computed gate/next-action/blocker fields.

See [runtime evidence](../verification/backend-parity-audit.json). The underlying
task loop works; the agent currently has to assemble and interpret its state.

## 2. Core work and agent operation

“Present” means the named capability exists in the reduced scope. “Partial” means
some behavior exists but the listed Python behavior has not been ported.
“Missing” means no implementation was found in the current TypeScript stack.

| Feature                            | Python behavior                                                                                                       | TypeScript status and gap                                                                                                                                                                               | Relevant owner                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Live gate and next-action guidance | One evaluated decision explains state, blockers, permitted routes and next work                                       | **Missing.** Raw state and recipe text are not a replacement                                                                                                                                            | Workflows + Tasks; tool/UI consumers                     |
| Basic task → delivery → review     | Immutable task goal, evidence, independent review; pass/revise/fail routes                                            | **Present for the small task loop.** Atomic verdict and transition, replay IDs and revision checks are implemented                                                                                      | Tasks + Reviews + Workflows                              |
| Producer ends an impossible task   | `task.transition(mark_failed)` from active task states, with a reason                                                 | **Missing.** A review can fail a task; a producer has no explicit exit command                                                                                                                          | Tasks                                                    |
| Dependencies between work items    | `depends_on` references to tasks/experiments; project checks, cycle rejection, success/failure evaluation             | **Missing.** No task input, dependency records or prerequisite gate. Cordis service dependencies do not provide work-item dependencies                                                                  | Domain work programs, with shared evaluation             |
| Task brief and delivery structure  | Server renders/pins the brief; delivery has one numbered confirmation per deliverable and evidence/checking details   | **Partial.** Caller creates a brief artifact; substring coverage replaces the old confirmation structure. Independent review still judges actual success in both implementations                        | Tasks + Artifacts                                        |
| Review scope and findings          | Several review roles; pinned snapshots; capabilities/session binding; findings, evidence and explicit return routes   | **Partial.** Task reviews have immutable evidence, independence, claim fencing and three outcomes. No experiment/reflection review programs or equally rich verdict contract                            | Reviews + owning task/program                            |
| Assignment context                 | Node-specific brief, project knowledge, references, revision feedback and execution policy                            | **Partial, with new useful foundations.** Versioned recipes, persisted contexts and checkpoints work. No automatic living-project context or generic node assignment/start interface                    | Context Builder + task type definitions                  |
| Interactive work activation        | `workflow.begin` checks revision and records actual node start                                                        | **Missing.** Creating a context does not implement activation or a work-start clock                                                                                                                     | Workflows + future assignments                           |
| Recovery after access loss         | Sessions close/fence work when authority, revision or lease is no longer valid; runners handle children               | **Partial.** Revoked reviewers' claims reopen durably, old claims cannot submit, and checkpoints can inform a replacement. No general producer reassignment, timeout/heartbeat recovery or agent launch | Domain Events + Reviews today; future assignments/runner |
| Agent identity and scoped sessions | Per-context `agent.hello`; parent lineage; expiring exact-node credentials and policy-bound tool arguments            | **Partial.** Durable actor identity and revocation exist. No distinct context-window/session identity, lineage, expiry or native per-assignment allowlist                                               | Scope + future sessions                                  |
| Autonomous execution               | Queue eligible nodes; exclusive lease, frozen assignment, heartbeat, process recovery and independent reviewer launch | **Missing.** No TypeScript runner or agent-work lease system                                                                                                                                            | Future assignments + runner                              |
| Composed workflows                 | Child instances, frozen join membership, named outcomes, stale-child fencing and explicit version migration           | **Partial.** Versioned graph definitions and durable instances exist; composition, joins and instance migration do not                                                                                  | Workflows                                                |
| Durable workflow actions           | Committed action outbox, delivery leases, stable IDs, retry/backoff and repair for failed effects                     | **Partial.** Domain Events durably retries synchronous local consumers. It is not a remote command/launch outbox or a multi-worker delivery system                                                      | Domain Events; future command delivery where needed      |
| Workflow history and repairs       | Agent history includes transitions, pending actions and repair state                                                  | **Internal-only / partial.** Transition history is stored and readable in process; the history tool was intentionally removed. No equivalent delivery repair view                                       | Workflows + UI                                           |

Sources: [Python task graph][py-task], [task document validators][py-documents],
[work dependencies][py-dependencies], [review contracts][py-research-tools],
[Agent Sessions][py-sessions], [workflow runtime responsibilities][py-workflows],
[composition][py-composition], [action delivery][py-delivery]. Current behavior:
[Tasks][ts-tasks], [Reviews][ts-reviews], [recovery and context][ts-recovery],
[Domain Events limits][ts-events].

The old delivery validator was explicitly structural, too. It required a
confirmation for every deliverable; it did not prove the work correct. A future
per-check evidence/verdict schema would improve the system, but should not be
described as restoring an automatic truth checker that Python already had.

## 3. Research capabilities

The original comparison is retained below; the Claims row is updated to the
current integration checkpoint. The current support additions are listed above.
The agent-authored logic-graph and project-graph obligations are retired by the
2026-09-16 ruling, so their absence from these rows is a decision, not a gap.

| Feature                          | Python behavior                                                                                                   | TypeScript status and gap                                                                                                                                                                                                                                                      | Likely owning component                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Project intent and document      | Introduction, overview and full research records; guarded intent updates                                          | **Partial.** Scope's project record has ID/name/date. No Introduction, research inventory or living project document                                                                                                                                                           | Project knowledge, separate from authentication policy |
| Claims                           | Durable statements/scope, confidence and status; links to experiments                                             | **Core/tools/UI implemented.** Scope permissions, CAS, retry receipts and events are integrated. Linked experiments, belief-history UI and reviewed reflection writes remain open. Built-browser retry, conflict, project and reader checks passed with synthetic credentials. | Claims; later Experiments and Reflections integrations |
| Experiment lifecycle             | Design, independent design review, execution, result review, attempts/retries and dependencies                    | **Missing.** `experiment.plan` is an ordinary task recipe, not this lifecycle                                                                                                                                                                                                  | Experiment program                                     |
| Research evidence and metrics    | Role/attempt-specific plans, results, reports and deterministic metrics exhibits                                  | **Missing as a research capability.** Generic immutable artifacts are available                                                                                                                                                                                                | Experiments + Artifacts                                |
| Literature workspace             | Section editing/order with revisions, paper ledger, citations linked to sections/claims/experiments               | **Missing.** The Nisa mount supplies research tools, not Merv's durable literature workspace                                                                                                                                                                                   | Literature                                             |
| Five-lens reflection             | Fixed corpus, three core/two authored lenses, child coordination, synthesis and independent review                | **Missing.** `project.reflection` supplies a task prompt and selected input artifacts only                                                                                                                                                                                     | Reflection program                                     |
| Project knowledge and staleness  | Reviewed claim changes, coverage snapshots, stale-knowledge gates and reflection advice                           | **Missing.** No reviewed claim publication or coverage/staleness calculation                                                                                                                                                                                                   | Research knowledge + Reflection                        |
| Code consolidation               | Pinned base/proposal SHAs, per-experiment disposition, validation, independent review and central-advance receipt | **Missing.** Task delivery can retain a document but does not enforce this protocol                                                                                                                                                                                            | Consolidation + runner workspace support               |
| Living Methods/Results synthesis | Frozen change packet, writing assignment, publication, coverage cursor and refresh/resume                         | **Missing.** Context Builder assembles inputs; it does not maintain or publish project knowledge                                                                                                                                                                               | Project synthesis program                              |
| Candidates and champion          | Candidate submission, durable staging receipt, compare-and-swap promotion and lineage                             | **Missing.** Generic artifacts alone do not track these decisions                                                                                                                                                                                                              | Candidates                                             |

Sources: [installed Python research program][py-program],
[research tool contracts][py-research-tools], [experiment program][py-experiment],
[reflection program][py-reflection], [project synthesis][py-synthesis],
[literature implementation][py-literature], [candidate/claim implementation][py-research].
Compare the actual [TypeScript recipe definitions][ts-recipes]. These rows are
capability boundaries, not a proposal to create one plugin for every table row.

## 4. Identity, storage, integrations and visibility

| Feature                             | Python behavior                                                                                                   | TypeScript status and gap                                                                                                                                                                 | Relevant owner                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Shared accounts and project access  | User identity, project membership, account/project keys and explicit project selection                            | **Partial.** Each actor belongs to one project and has one role/token. Separate actors can exist in separate projects; one shared user identity does not yet span them                    | Scope                                 |
| Browser/MCP authentication          | Supabase JWT validation, OAuth authorization/refresh and key/session controls                                     | **Missing equivalents.** TypeScript accepts actor bearers. Nisa uses explicit upstream credential bindings; shared login is not deployed                                                  | Scope + authentication adapters       |
| Database providers                  | SQLite and pooled Postgres                                                                                        | **Partial.** SQLite only; synchronous SQL/transaction contracts and SQLite migrations                                                                                                     | State + consumers' migrations         |
| Research artifact storage           | Merv-owned R2 bytes behind a blob interface                                                                       | **Partial.** Local disk blobs only; hashes, immutable metadata and project access already work                                                                                            | Blobs + Artifacts                     |
| Artifact transfer and attachments   | Bounded one-use uploads, expiry, figure manifests, completeness checks and batch/target/role reads                | **Partial.** Inline UTF-8/base64 create/read and pinned task/review references. No equivalent upload lifecycle or document figure manifest                                                | Artifacts + consumer associations     |
| Sandbox work                        | Independent service facade for offers, provision/reuse/attach, SSH, jobs, output retention, extension and release | **Partial integration foundation.** Generic MCP mounts/grants/credentials work; read-only sandbox invocation was verified. No native research-aware sandbox workflow or full compute path | Mounts + sandbox-specific integration |
| Heavy datasets/models               | Independent sandbox service handles durable object receipts, upload/download, retention and deletion              | **Missing integrated equivalent.** Local research blobs are not this service                                                                                                              | Remote storage integration            |
| Feed conversations and presentation | Voices/bios, threads, replies, quotes, reactions, typed visual attachments, previews and posting advisories       | **Partial.** Immutable posts, artifact attachments, cursor reads and activity exist. The richer conversation/presentation model is absent                                                 | Feed + its UI                         |
| Tool-call diagnostics               | Durable per-call/refusal ledger, latency/size/error metadata, context attribution and retained payloads           | **Missing equivalent.** Domain events and request deduplication do not record every tool call/refusal                                                                                     | API/Tools + telemetry                 |
| Backend views and controls for UI   | Rich research dashboards, project/session controls, traces and research-specific views                            | **Partial.** Plugin-driven UI reads tasks, reviews, artifacts, actors, feed/activity and connections. It is currently read-only and lacks the missing domain capabilities                 | UI adapters + domain owners           |

Sources: [Python authentication][py-auth], [OAuth][py-oauth],
[Postgres adapter][py-postgres], [artifact lifecycle][py-artifacts],
[sandbox/storage facade contracts][py-infrastructure], [feed model][py-feed],
[tool-call ledger][py-ledger], [Application views][py-application]. Current limits:
[TypeScript Scope][ts-scope], [UI][ts-ui], [sandbox proof][ts-sandbox],
[Nisa integration/deployment limits][ts-nisa].

The sandbox service itself still exists. Missing TypeScript integration does not
mean its compute/storage implementation needs to be rewritten inside Merv.
Similarly, the Nisa mount is a useful addition but does not close the literature,
project-knowledge or shared-account gaps above.

## 5. The first implementation slice

Start with **live guidance for the existing task loop**, before introducing a new
research program or automatic runner.

1. Define a compact decision: current state/revision, gate, next action, blockers,
   relevant evidence/review references and whether the assignment has ended.
   Account for the caller's role and current review claim.
2. Let Workflows supply generic evaluation machinery and Tasks supply its domain
   rules. Use the same rules for status and command enforcement. Commands must
   recheck them inside their transaction; an earlier status read grants nothing.
3. Expose the decision through a narrow status-and-next tool. Start with tasks;
   add project/experiment/generic-instance scope as those capabilities exist.
4. Have Tasks pass this decision into its context recipe and UI view. Context
   Builder remains a generic assembler. It must not import Tasks or duplicate
   gate policy. No task-context adapter plugins are needed.
5. Verify the whole loop: new work, review requested, review claimed, revision
   requested, terminal verdict, revoked reviewer, replacement claim and stale
   revision. Guidance must neither tell the producer to review itself nor let an
   unclaimed reviewer submit. Show what is actually possible for each actor.

Some guards need command inputs. For example, `task.submit_delivery` receives
artifact IDs and validates them during submission; an unattached artifact is not
automatically the task's proposed delivery. Status should say which input is
required, rather than claim it has validated evidence it has never selected.
An optional preflight can reuse that validator if needed.

After that slice is integrated, the next small task-level gaps are an explicit
producer failure path, task dependencies, and structured delivery confirmations.
Each should update commands, guidance, context, UI and behavioral tests together.
These are proposed priorities, not newly completed features.

The larger storage, identity, sandbox and runner prerequisites remain in the
[execution plan](../EXECUTION_PLAN.md). Research programs should be restored as
complete paths on those foundations. Claims is now integrated; a complete
Experiment program is next, with reflection and consolidation after real
experiment records exist. Not every old feature must be
restored to deliver a useful reduced Merv, but omissions should be explicit.

## 6. Audit method and verification

- Read the Python default program manifest, owner tool contracts, workflow
  graphs, task document validators, status presentation, session runtime and
  component responsibilities; compared them with TypeScript contracts,
  implementations, registered tools, recipes and integration evidence.
- Exported the [Python manifest](../verification/python-tool-inventory.json):
  68 declared entries, of which 53 are public and 15 internal, before runtime
  feature/credential filtering. Infrastructure entries delegate to a separate
  service. Tool counts are not feature-parity percentages.
- Ran `tests.application.test_status_guidance`,
  `tests.application.test_guidance_consumers`, and `tests.workflow.test_plugins`
  in Python: **24 tests passed**. They cover canonical blocker order, prerequisites,
  review guidance, shared consumers and custom-program guidance.
- Ran the actual TypeScript registry probe described above. No production data,
  live external tools or running user server was used.
- No runtime implementation was changed during this audit. Wider feature rows
  are source-backed findings, not a claim that every old service was retested or
  that production Python behavior was reproduced end to end.

[py-workflow-tools]: ../../merv/src/merv/brain/workflows/tools.py
[py-graph]: ../../merv/src/merv/brain/workflows/graph.py
[py-status]: ../../merv/src/merv/brain/application/workflow.py
[py-program]: ../../merv/src/merv/brain/programs/research.py
[py-task]: ../../merv/src/merv/brain/workflows/definitions/task.py
[py-documents]: ../../merv/src/merv/brain/workflows/definitions/documents.py
[py-dependencies]: ../../merv/src/merv/brain/research_core/dependencies.py
[py-research-tools]: ../../merv/src/merv/brain/research_core/tools.py
[py-sessions]: ../../merv/src/merv/brain/agent_sessions/agent_sessions.md
[py-workflows]: ../../merv/src/merv/brain/workflows/workflows.md
[py-composition]: ../../merv/src/merv/brain/workflows/composition.py
[py-delivery]: ../../merv/src/merv/brain/workflows/delivery.py
[py-experiment]: ../../merv/src/merv/brain/workflows/definitions/experiment.py
[py-reflection]: ../../merv/src/merv/brain/workflows/definitions/reflection.py
[py-synthesis]: ../../merv/src/merv/brain/workflows/definitions/project_synthesis.py
[py-literature]: ../../merv/src/merv/brain/literature/literature.py
[py-research]: ../../merv/src/merv/brain/research_core/research.py
[py-auth]: ../../merv/src/merv/brain/surface/auth.py
[py-oauth]: ../../merv/src/merv/brain/surface/oauth.py
[py-postgres]: ../../merv/src/merv/brain/kernel/state/dialects.py
[py-artifacts]: ../../merv/src/merv/brain/artifacts/artifacts.md
[py-infrastructure]: ../../merv/src/merv/brain/infrastructure/tools.py
[py-feed]: ../../merv/src/merv/brain/feed/feed.md
[py-ledger]: ../../merv/src/merv/brain/kernel/state/tool_call_ledger.py
[py-application]: ../../merv/src/merv/brain/application/application.md
[ts-contracts]: ../packages/contracts/src/index.ts
[ts-workflows]: ../packages/workflows/src/index.ts
[ts-tasks]: ../packages/tasks/src/index.ts
[ts-task-tools]: ../packages/tasks/src/tools.ts
[ts-recipes]: ../packages/tasks/src/definitions.ts
[ts-reviews]: ../packages/reviews/src/index.ts
[ts-recovery]: RECOVERY_AND_CONTEXT.md
[ts-events]: ../packages/domain-events/README.md
[ts-app-test]: ../tests/app.test.ts
[ts-scope]: ../packages/scope/src/index.ts
[ts-ui]: UI_PLUGIN.md
[ts-sandbox]: READ_ONLY_SANDBOX_MOUNT.md
[ts-nisa]: NISA_PLUGIN_IMPLEMENTATION.md
