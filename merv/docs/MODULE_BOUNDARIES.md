# Module Boundaries

The brain is a modular monolith. Two independent classifications describe it:

- a **component** says which capability owns a file;
- a **layer** says what architectural job that file performs.

This distinction is intentional. Research, Artifacts, and Feed are business components. Infrastructure adapts
the external merv-sandboxes service to research associations and policy; MLflow
is an outbound tracking integration. Physical compute and storage live outside
the Merv process.

```text
                       bootstrap / composition
                    /          |             \
                   v           v              v
              delivery --> application <-- adapters
                                  |
                                  v
                           component APIs/ports
                                  |
                                  v
                                kernel
```

The pure `merv.shared` package sits outside this brain-only law.

## Component law

Every `src/merv/brain/**/*.py` file has exactly one component. Deepest-prefix
classification plus file overrides handles mixed packages.

| Component | Physical code today | Meaning |
|---|---|---|
| Kernel | `kernel/**` | shared contracts, state floor, IDs, events, utilities |
| Research | `research_core/**`, `literature/**` | project, claim, experiment, review, reflection, and literature authority |
| Workflows | `workflows/**` | versioned graphs, transition evaluation, context builders, durable runtime, and composition |
| Artifacts | `artifacts/**` | submitted artifacts, upload tokens, pinned evidence |
| Infrastructure | `infrastructure/**` | native HTTP adapters, sandbox associations, and the heavy-object facade over merv-sandboxes |
| Feed | `feed/**` | authors, posts, replies, reactions, history, and advisories |
| Application | `application/**` | cross-component commands, reactions, and composite reads |
| Tracking integration | `mlflow/**` | MLflow implementation of tracking ports |
| Surface | `surface/**` | HTTP/MCP delivery and the co-located composition root |

The exact component import matrix is:

| Importer | May import |
|---|---|
| Kernel | Kernel |
| Research | Research, Workflows, Artifacts, Kernel |
| Workflows | Workflows, Kernel |
| Artifacts | Artifacts, Kernel |
| Infrastructure | Infrastructure, Kernel |
| Feed | Feed, Kernel |
| Application | Application, Workflows, Research, Artifacts, Infrastructure, Feed, Agent sessions, Kernel |
| Tracking integration | Tracking integration, Application, Kernel |
| Surface | any component; its independent layer classification still applies |

Outside bootstrap, code enters another component only through its declared
package root or a genuinely independent `ports/**` capability. A module named
`core.py` is not automatically public. Research enters Artifacts through its
single concrete package-root `Artifacts` capability. This is the executable
form of “one stable public root”; it prevents a new use case or adapter from
depending on internal services. Every cross-component import must enter through
a declared public entrypoint. Workflow reads use
`Research.snapshot` and `SandboxReads`; native sandbox commands enter through
the package-root `RemoteSandboxes` capability.
An application service deliberately exported from a component package root is
itself a valid public entrypoint; Surface may type against it directly when no
independent projection or capability constraint exists. Internal service-module
imports remain forbidden.

Surface constructs Workflows and injects it into Research. Research binds its
existing records through Workflows' typed read/create/commit capabilities.
Definitions and context builders receive project-bound read-only knowledge;
they import no supporting service or SQL connection. Graphs, definitions,
registry and composition values are domain code; workflow persistence and
action delivery are application code. Experiment, task, reflection, independent
lens, and published research-wave flows use this runtime. Generic and legacy
tool paths share the registered graph evaluation.

Research reaches immutable artifact evidence only through typed operations on
the concrete `Artifacts` root; it never sees Artifact tables or blob locators.
Research's association adapter resolves native targets and seals selected
immutable content references on the same transaction as the graph transition.

## Layer law

The current layer mapping is deliberately honest about mixed directories:

| Layer | Representative paths |
|---|---|
| foundation | `kernel/**` |
| port | `kernel/ports/**`, `infrastructure/ports.py`, the `ProducedObjectCatalog` and `ObjectLifecycle` protocols |
| domain | `workflows/{graph,composition,definitions/**}` and pure component policy |
| application | component roots such as `infrastructure/objects.py` and cross-component work under `application/**` |
| adapter | `mlflow/**`, `infrastructure/client.py` |
| delivery | ordinary `surface/**` HTTP/MCP/auth/serialization code |
| bootstrap | Surface composition/config/control wiring, the HTTP process launcher |

merv-sandboxes owns heavy objects outright: names, auto-incremented versions,
state, verification, retention, quota, expiry and bytes. `infrastructure/objects.py`
(`RemoteObjects`) is Infrastructure-component **application** code that
composes the transfer-target and run-command helpers in
`infrastructure/storage.py` over the `InfrastructureTransport` port and keeps
only one-time completion tokens. It declares an `ObjectLifecycle` protocol;
`research_core/objects.py` implements it to record which experiment produced
an object, the submitter's classification and provenance, and a metadata
snapshot at completion. The facade never reads those facts back. No cloud SDK
or physical object-store implementation is part of Merv.

Imports must point inward:

- foundation -> foundation;
- port -> port/foundation;
- domain -> domain/port/foundation;
- application -> application/domain/port/foundation;
- adapter -> adapter/application/domain/port/foundation;
- delivery -> delivery/application/port/foundation;
- bootstrap -> any layer.

Nothing except bootstrap may import bootstrap, and no non-delivery layer may
import delivery. `LAYER_EXCEPTIONS` is empty, so every newly detected cross-layer
edge fails immediately; there is no wildcard or compatibility allowance.

## Ports and adapters

Research/application workflows depend on an `ExperimentTracking` port, not on
MLflow. `CentralMlflowService` implements it. The port distinguishes logging,
control, and readback capabilities so tracking-only and server-only deployments
retain their current behavior.

`mlflow.context`, `experiment.get_state`, and `mlflow.finalize_run` enter through
application-owned query/command objects. Surface registers their bound methods
and does no tracking policy or persistence coordination. A canonical finalize
returns its exact `experiment.mlflow_run_refreshed` event from Research and
synchronously dispatches the Feed advisory after response assembly. Finalizing
an explicit foreign run keeps the old advisory response but writes no event and
never changes the experiment's canonical run identity.

Artifacts and Feed depend on the narrow `EvidenceBlobStore` port owned by
Kernel. Feed behavior lives in the single readable `feed/feed.py`
implementation; only Feed-owned DDL and compatibility upgrades live in its
narrow `feed/persistence.py` helper. MCP and HTTP delivery use the public
package-root `FeedService` directly; their frozen schemas, routes, authorization,
and response hardening are the real delivery boundaries. The narrow
`FeedAdvisory` protocol preserves the independent post-commit boundary. Safe
outbound previews are supplied through the Kernel `WebPreview` port by the
Surface adapter, which is also shared with Literature's allowlisted paper
  preview.
Application response composition depends on its `ProducedObjectCatalog` port
(`application/experiments/presentation.py`); `ResearchObjects` implements it
from Research's completion snapshot, so experiment views need no service call
and stay readable when storage is disabled. Artifacts and Feed consume only
`put/get` from their binary blob port; cleanup consumes its separate expiry
capability. Local and S3 binary implementations remain replaceable adapters,
while heavy transfers stay behind the Infrastructure transport port.

Operator-triggered cleanup is a cross-component use case in
`application/maintenance.py`; Surface only exposes its injected entry point.
Heavy-object expiry is not part of it: merv-sandboxes reaps its own objects.
An Application query combines a Kernel-owned tenant event count with
Sandbox-owned generation counters and injects the result into admin delivery.

The declarative `TOOL_MANIFEST` owns tool schemas, visibility, scope, execution,
features, and handler identities. Surface derives its control handlers from
those identities; every tool is a control tool served by the brain, so
hidden/handler routing is not separately maintained. The transition adapter
still sets the agent credential audience. Cross-module project and
experiment-list decisions live in `application/tool_commands.py`; storage-only
tool operations call the owning `RemoteObjects` root directly.

These are dependency changes, not service extraction: everything still runs in
one brain process and shares the existing transaction/event ledger.

Agent Sessions is a small application component: it owns durable worker
identity, leases, and experiment/review exclusivity. Cross-component candidate
selection remains in Application; Workflows owns graph state and assignment
prerequisites; Surface owns runner transport and the MCP-only default-deny session
policy; the machine-local runner owns process and worktree adapters.

## Action delivery and advisories

Workflow transitions atomically commit native record changes, history, their
exact event, and requested support actions. The action outbox uses stable keys,
expiring leases and conditional acknowledgements. Application's delivery worker
runs during the HTTP server lifespan and calls review, child-start and optional
tracking capabilities. It does not reconstruct workflow decisions. Review
capabilities are renewed only while the exact submitted node still waits.

Tracking begins on actual node activation, through an agent lease or explicit
`workflow.begin`, and terminal actions capture their exact run ID. Late readback
cannot overwrite a later attempt's run. External effects require idempotency or
a durable ambiguity fence; automatic retry must never create duplicate work.

Feed advisories remain optional, immediate presentation: explicit tracking
finalization attaches its reminder after response assembly, and a producer can
read its review verdict reminder through `review.status`. Advisory failure does
not reverse a committed workflow action or independent review.

## Composite query model

Composite UI reads likewise belong to Application. `application/workflow.py`
assembles workflow orientation and the project dashboard from one bulk Research
snapshot plus Sandbox reads; `application/queries.py` owns tracking overview,
experiment figure, hydrated compute costs, and experiment/project/reflection
logic graphs. Artifacts owns
submitted artifact-content and figure selection behind `Artifacts`;
Application owns hosted content-response and experiment/figure presentation.
Surface retains authentication, conditional HTTP caching, local-field
redaction, MIME/header shaping, and serialization only.

The bulk snapshot is backed by plural Research state/gate reads and batched
`Artifacts` target reads. Dashboard query cost therefore remains bounded rather
than growing once per experiment. Full Artifact pages use six reads, Research graph
references use at most one read per reference type, and MLflow overview uses at
most three remote calls. Reflection history is the deliberate exception: its
frozen response returns every rich historical wave, so it remains linear and
has explicit query ceilings for representative 25-wave abandoned and published-
graph histories instead of a false constant-query claim. A future summary or
paginated contract should precede batching that endpoint.

Workflows evaluates the registered graph during native record hydration. The
typed, JSON-safe evaluation carries requirement, validation, current-snapshot
review-request, blocker, and legal-transition facts. That same value enforces
transitions, supplies the semantic checklist, travels in `ResearchSnapshot`,
and drives workflow guidance. Application may combine those facts with live
Sandbox state for presentation, but it cannot reconstruct transition legality.
Review requests likewise read their expected role from the current evaluation;
there is no parallel status-to-review-role map.

Workflow definitions contain semantic roles, evidence status, domain
enforcement errors, human-readable transition preconditions, blocker codes,
legal transitions, semantic next actions, tools, templates, reviewer skills,
and rejection routes. Application formats that declared guidance, adds
cross-module operational advice, and preserves the public response shape.
Reflection drift signals remain facts; Application derives their prose and
post-publish presentation.
`StatusAndNextQuery` joins one Research snapshot with Sandbox and
produced-object facts before applying that pure guidance policy.

Review role/verdict validation and project membership invariants are Research
policy; artifact association role/target validation belongs to Research's
association adapter, while generic content validation belongs to Artifacts. HTTP
routes call the concrete `Research` root and do not reach through to a store.

## Research shape

`research_core.Research` is the sole public root for projects, claims, native
research records, reviews and evidence associations. Its private experiment,
task and reflection services bind those records to the workflow runtime. One
canonical `snapshot` operation hydrates project facts and graph evaluations in
batches. Native workflow files are passive views of the canonical definitions;
`workflow_schema.py` supplies compatibility formatting, not a second state machine.
Pure workflow rules and document validation live in `workflows/definitions`.

Literature remains a separate component. Application composes capabilities,
formats guidance and delivers requested support actions. Surface owns HTTP/MCP
schemas, authentication, authorization transport, and response serialization.
Node instructions belong to workflow definitions and are carried in the same
version/revision packet used for the real assignment lease.

## Cross-package law

Brain code may import pure `merv.shared` contracts. Shared code imports only the
standard library and itself. The onboarding client ships in the slim bundle and
imports only the standard library and `merv.shared`, never `merv.brain`.

## Executable ratchets

`tests/structure/test_module_boundaries.py` AST-scans top-level and
function-local imports, classifies every brain file twice, enforces both laws,
checks component-owned SQL, and rejects stale table entries and stale exception
pairs. Every stable table has an explicit owner; an unclassified new table
fails closed. SQL may name only tables owned by the file's component, Kernel
tables, or tables behind a ratified component dependency. Research has a
zero-entry foreign-Artifact-table counter, so any new direct evidence SQL fails
immediately.

Application has a zero-exception purity check: it may not import delivery,
concrete adapters, frameworks, database/network SDKs, environment access, or
state/config modules or state-store types; accept persistence parameters; open
connections/transactions; or contain SQL. Non-bootstrap code may not construct
another component's concrete collaborator. Surface delivery has zero-baseline,
fail-closed scans for internal implementations, persistence reach-through, and
whole-app dependency carriers. Public package-root services are allowed; their
internals and stores are not.

Untyped collaborator declarations are separate from JSON payload debt. A
shrinking dependency ledger records the remaining callable seams and injected
adapter test doubles. New `Any` or generic `Callable` collaborators fail;
repaired entries must be removed from the ledger.

Public boundary value objects—including exported Application response/event
values—are discovered by structure tests, normalized to JSON primitives, and
round-tripped with strict finite-number handling. A complete sample registry
prevents new DTOs from escaping the test. Untyped fields and non-string mapping
keys are an exact shrinking debt ledger; there is no remaining JSON-roundtrip
exception. Concrete connections, cursors, stores,
repositories, and services are never permitted in boundary values.

Infrastructure exposes `RemoteSandboxes` and `RemoteProviders` at its public
package root. Research associations and saved admission policy remain in Merv;
provider credentials, cloud-specific dispatch, lifecycle, and cleanup belong
to merv-sandboxes. The HTTP adapter signs short-lived project namespace tokens.
Production imports cannot reach retired provider or S3 modules. Test-only
fake transports exercise project isolation, jobs, storage, and budget claims
without provisioning machines.
