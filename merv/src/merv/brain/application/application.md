# Application

## Purpose
Application coordinates product operations that cross module boundaries. It
does not own research state, artifact bytes, sandboxes, feed posts, heavy
objects, authentication, or transport. Those remain with their module roots.
Surface calls one concrete `Application`, and only for work that joins two of
them: a route or tool whose whole job is one component's call takes that
component from composition instead. One `return` into a collaborator is not a
method that belongs here.

## Main flow

`application.py` is the readable root. It composes Research facts with
Artifacts, Feed, and the merv-sandboxes facades only when an operation genuinely
spans them. Research owns event ledger reads. Keep this note under 100 lines;
qualify named action, role, tool and skill references inline.

- `status` and `status_for_agent` preserve rich UI and slim agent views, in
  project, experiment, or task scope. `instance_id` selects any registered
  workflow and its node-owned brief through the Workflows root.
- Native state remains typed through application logic. `Public` beside the graph
  declares hidden fields and public names; `public_record` serializes dataclass
  fields, enums and computed values, preserving omission independently of null.
- One kind's work is called on that kind's service (`research.experiments`,
  `tasks`, `reflections`, `reviews`); nothing forwards through the root.
- Task create/list/get/transition carry no exhibit: a task commits through its
  service, then adds a best-effort Feed advisory.
- Experiment preparation reads metrics outside the transaction; Research locks
  and rechecks its workflow revision, attempt and source evidence before pinning
  the exhibit and its verdict atomically. The final graph gate runs afterward.
- `tool:review.start` returns the workflow's brief and immutable snapshot for any role;
  native views also hydrate pinned research artifacts and bounded context.
- Reflection commands use the same graph/runtime and present either
  compact agent documents or the richer UI overview.
- Dashboard and cost join facts without exposing module internals to Surface;
  the event ledger is read from Research at the routes that serve it.
- Candidate submission resolves and pins an Artifact or storage-object pointer, or
  records a pathless experiment-workspace nomination; Research owns the
  immutable candidate and champion lineage.
- Agent-session leases enumerate dispatchable workflow nodes. Runner control
  itself — attach, heartbeat, release, halt, traces, tuning — is Agent
  Sessions' own and is called there. Each node declares its role, concise
  brief, exact references and execution policy (tools, scopes, sandbox,
  workspace). Agent Sessions rechecks the pinned revision inside the lease
  transaction and freezes the packet. Authentication records actual work
  start; a revision change fences its old credential. Application decorates
  listed leases with native ids and the job kind, and maps the runner's
  generic central-advance routes onto the reflection receipt. New plugins need
  no dispatch cases.

## Files

- `application.py`: the single public root and visible cross-module workflows.
- `workflow.py`: rich/slim status composition and project-orientation helpers.
- `status_guidance.py`: formats graph evaluations; it evaluates no gate itself.
- `project_context.py` and `experiments/context.py`: bounded context packets.
- `experiments/transition.py`: experiment transition ordering and exhibit pin.
- `tasks.py`: task presentation, transition receipts, and the bounded task context
  (brief, delivery, deliverables, dependencies) for status and review start.
- `experiments/exhibits.py`/`metrics_exhibit.py`: deterministic exhibits.
- `experiments/presentation.py` and `create.py`: the experiment's
  declared public shape and create inputs; claim suggestions are deliberately absent.
- `reviews.py`, `reflections.py`, and `reflection_guidance.py`: review handoff,
  reflection presentation, and guidance.
- `queries.py`: logic-graph composition, built once and shared by its routes.
- `maintenance.py`: token/log retention and lease cleanup; merv-sandboxes owns machine
  and object expiry.
## Boundaries and invariants

- Workflows owns graph decisions, guards and handoff context; Research owns review
  security, native records and evidence associations.
- Artifacts owns immutable content; workflow definitions validate evidence meaning.
- Sandbox, object storage, and Feed are called through their concrete package roots; the
  only Application port is `ProducedObjectCatalog`, which Research's completion snapshot
  implements so experiment views need no service call.
- Agent Sessions owns worker identity and leases; Application binds narrow workflow
  assignment and activation callbacks. The workflow runtime owns candidate evaluation,
  the final transactional check, and the instance facts.
- Graph changes queue durable actions with their committed event. The composition root
  supplies one handler per effect kind an installed program declares, so the worker
  knows only that a name has a handler. It retries support-system calls using stable
  keys and fenced leases; permanent validation/authorization/missing-target failures stop
  polling until project-scoped `Deliveries.retry` requeues their existing id and attempts.
- Artifact sealing and Research mutations retain their existing transaction boundaries.
  Feed effects occur after commit and remain advisory.
- Feed advisories: `experiments/transition.py` phrases what a committed event is called;
  the Feed only decides whether the feed already covers that ref; exceptions are logged.
- Large candidates stay in merv-sandboxes. Application pins candidate pointers through
  the object facade and reads the producing experiment from Research; it never queries a
  sibling's persistence tables.
- Surface owns HTTP/MCP models, authentication, formatting, and UI-only projections.

## Forbidden regression

Do not recreate a service bag, generic event bus, facade, repository, or
Application-owned port forest, and do not grow a pass-through back: new
cross-module behavior belongs as a clear method on `Application`, while
module-local behavior belongs on the module root and is called there.
