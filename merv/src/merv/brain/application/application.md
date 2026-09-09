# Application

## Purpose

Application coordinates product operations that cross module boundaries. It
does not own research state, artifact bytes, sandboxes, feed posts, heavy
objects, authentication, or transport. Those remain with their module roots.
Surface calls one concrete `Application`; module-local tools call their owning
module directly.

## Main flow

`application.py` is the readable root. It composes Research facts with
Artifacts, Sandbox, Feed, and Object Storage only when an operation genuinely
spans them. Research remains the public owner of its event ledger reads.

- `status` and `status_for_agent` preserve rich UI and slim agent views, in
  project, experiment, or task scope. `instance_id` selects any registered
  workflow and its node-owned brief through the Workflows root.
- Experiment create/list/get/transition retain native record views while
  Workflows owns decisions and Research owns the transactional record binding.
- Task create/list/get/transition mirror them without exhibits or tracking:
  a task commits through Research, then adds a best-effort Feed advisory.
- Experiment preparation reads metrics outside the transaction; Research locks
  and rechecks its workflow revision, attempt and source evidence before pinning
  the exhibit and its verdict atomically. The final graph gate runs afterward.
- Review start returns the workflow's brief and immutable snapshot for any role;
  native views also hydrate pinned research artifacts and bounded context.
- Reflection commands use the same graph/runtime and present either
  compact agent documents or the richer UI overview.
- Dashboard, cost, timeline, graph, and figure-fact reads join facts without
  exposing module internals to Surface.
- Candidate submission resolves and pins an Artifact/Object Storage pointer, or
  records a pathless experiment-workspace nomination for evaluator staging;
  Research owns the immutable candidate and champion lineage.
- Agent-session claims enumerate dispatchable workflow nodes. Each node declares
  its role, concise brief, exact references, read-only policy and workspace mode.
  Agent Sessions rechecks the pinned revision and prerequisites inside the lease
  transaction and freezes the packet. Authentication records actual work start;
  a node change fences its old credential. New plugins need no dispatch cases.

## Files

- `application.py`: the single public root and visible cross-module workflows.
- `workflow.py`: rich/slim status composition and project-orientation helpers.
- `status_guidance.py`: compatibility projection of canonical graph evaluations.
- `project_context.py` and `experiments/context.py`: bounded context packets.
- `experiments/transition.py`: experiment transition ordering and exhibit pin.
- `tasks.py`: task presentation, transition receipts, and the bounded task
  context (brief, delivery, checks, dependencies) for status and review start.
- `experiments/exhibits.py` and `metrics_exhibit.py`: deterministic observation
  exhibit construction.
- `experiments/presentation.py`, `create.py`, and `claim_guidance.py`: released
  experiment views and compatibility input translation.
- `reviews.py`, `reflections.py`, and `reflection_guidance.py`: review handoff,
  reflection presentation, and guidance.
- `queries.py`: logic-graph composition only.
- `mlflow.py`: the only optional MLflow integration contract and behavior.
- `maintenance.py`: research object-ledger expiry, token/log retention and
  coding-agent lease cleanup. Infrastructure workers own machine and byte expiry.

## Boundaries and invariants

- Workflows owns graph decisions, guards and handoff context; Research owns review
  security, native records, evidence associations and tracking-delivery receipts.
- Artifacts owns immutable content; workflow definitions validate evidence meaning.
- Sandbox, Feed, and Object Storage are called through their concrete package
  roots; Application defines no mirror facades or forwarding ports.
- Agent Sessions owns worker identity and leases; Application binds narrow
  workflow assignment, validation, and activation callbacks. The workflow
  runtime owns both candidate evaluation and the final transactional check.
- MLflow is optional. All adapter calls, tracking DTOs, degraded warnings,
  idempotent post-commit run handling, and overview reads live in `mlflow.py`.
- Graph changes queue durable actions with their committed event. The delivery
  worker retries support-system calls using stable keys and fenced leases.
  Non-idempotent tracking creation fences automatic retries before its remote
  call; ambiguous outcomes wait for explicit run attachment and remain visible
  in `workflow.history.actions`. Transient reads and finalization still retry.
- Artifact sealing and Research mutations retain their existing transaction
  boundaries. MLflow and Feed effects occur after commit; Feed and automatic
  MLflow finalization failures remain advisory.
- Large candidates stay in Object Storage. Application validates candidate
  pointers through module roots and never queries sibling persistence tables.
- Surface owns HTTP/MCP models, authentication, formatting, and UI-only
  projections such as `surface/experiment_figure.py`.

## Forbidden regression

Do not recreate a service bag, generic event bus, facade, repository, or
Application-owned port forest. New cross-module behavior belongs as a clear
method on `Application`; module-local behavior belongs on the module root.
