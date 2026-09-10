# Module boundaries

The brain is a modular monolith. Two independent classifications describe every
file under `src/merv/brain/`:

- a **component** says which capability owns it;
- a **layer** says what architectural job it does.

`tests/structure/test_module_boundaries.py` and
`tests/structure/test_support_vocabulary.py` are the executable form of this
document. When prose and those tests disagree, the tests are right.

## Three layers

Merv is one science and the machinery that carries it:

1. **Research** is the science: projects, claims, experiments, tasks, reviews,
   reflections, literature, the workflow graphs that sequence them, and the
   cross-component coordination that composes them for a caller.
2. **Support** carries research work without knowing what it is: immutable
   content, the project feed, agent leases, credentials and identity, the
   HTTP/MCP surface, the runner. Support stores and echoes an id research gave
   it; it never interprets one.
3. **ML infrastructure** adapts the external merv-sandboxes service, which owns
   compute, provider credentials, jobs, and heavy objects. No cloud SDK and no
   physical object store is part of Merv.

**Kernel** sits under all three: the shared state floor, events, the tool-call
ledger, IDs, the tool-contract type, and narrow ports.

The rule that makes this hold is *research declares, support enforces*. When
support needs to know what a session may do, the answer is data the workflow
node declared and the packet carried — never a switch on a record kind. When
support needs something from research, it declares a `Protocol` **in the
support module**, research or application implements it, and
`surface/surface.py` wires the two together.

## Components

| Component | Code | Owns |
|---|---|---|
| Kernel | `kernel/**` | state floor and dialects, events, tool-call ledger and payloads, request context, IDs, `ToolContract`, ports |
| Research | `research_core/**`, `workflows/**`, `literature/**`, `application/**`, and the research files inside `surface/` | claims, experiments, tasks, reviews, reflections, papers, evidence associations, the versioned graphs and their runtime, cross-component commands and composite reads |
| Artifacts | `artifacts/**` | immutable content, upload tokens, figures, sealed submissions |
| Feed | `feed/**` | authors, posts, threads, reactions, previews |
| Agent sessions | `agent_sessions/**` | runner identity, pairing, leases, traces, workspaces |
| ML infrastructure | `infrastructure/**` | the merv-sandboxes transport, sandboxes, providers, spend reporting, the heavy-object facade |
| Surface | the rest of `surface/**` | HTTP/MCP delivery, auth, OAuth, project keys, agent identity, the tool registry and dispatcher, telemetry, and the composition root |

Research lives inside `surface/` wherever the science reaches HTTP: the
`experiments`, `reflections`, `claims`, `reviews`, `tasks`, `views` and
`sandboxes` routers, `surface/experiment_figure.py`, and
`surface/workflow_knowledge.py`. `FILE_COMPONENTS` in the boundary test names
them.

## Component import law

| Importer | May import |
|---|---|
| Kernel | Kernel |
| Research | Research, any support component, ML infrastructure, Kernel |
| Artifacts / Feed / Agent sessions | itself, Kernel |
| ML infrastructure | itself, Kernel |
| Surface | anyone; its layer classification still applies |

A support component sees only itself and Kernel, so no research meaning can
travel sideways between the things that carry it. Surface composes, so Surface
may name anyone; two files that both live in `surface/` may import each other,
because the research files hosted there share their host's request plumbing and
presenters — the split inside `surface/` exists for the vocabulary law and for
this document, not for imports.

Outside the composition root, code enters another component only through its
declared package root (`__init__.py`), an `api.py`/`facade.py`, or a genuinely
independent `ports/**` capability. A module named `core.py` is not public.
Research enters Artifacts through exactly one door: the concrete `Artifacts`
capability on the package root — never an Artifact table or a blob locator.
Only bootstrap constructs another component's concrete collaborator; everyone
else receives a facade or a port.

## Layer law

| Layer | Representative paths |
|---|---|
| foundation | `kernel/**` |
| port | `kernel/ports/**`, `infrastructure/ports.py` |
| domain | `workflows/{graph,composition,registry,definitions/**}` and pure policy |
| application | component roots, `research_core/**`, the `workflows/` runtime and delivery, `application/**`, `infrastructure/objects.py`, the Surface flows that own their own tables |
| adapter | `infrastructure/client.py`, `artifacts/r2.py`, `kernel/state/dialects.py`, `surface/{web_preview,oauth_store}.py` |
| delivery | ordinary `surface/**` HTTP/MCP/auth/serialization code |
| bootstrap | `surface/surface.py`, `surface/config.py`, `surface/transport/http_server.py` |

Imports point inward: foundation → foundation; port → port, foundation; domain
→ domain, port, foundation; application → application, domain, port,
foundation; adapter → adapter, application, domain, port, foundation; delivery
→ delivery, application, port, foundation; bootstrap → anything. Nothing but
bootstrap imports bootstrap, and no non-delivery layer imports delivery.
`LAYER_EXCEPTIONS` is empty: a new cross-layer edge fails immediately.

Application has a zero-exception purity check on top of the layer law. It may
not import delivery, a concrete adapter, a framework, a database or network
SDK, environment access, or a state module; it may not name a store type,
accept a connection or cursor, open a transaction, or contain SQL.

## The support vocabulary law

Support may carry research work; it may not speak research. Every source file
in Artifacts, Feed, Agent Sessions, Kernel, the support half of Surface, the
client and shared is tokenized, and no identifier or string literal may say
`experiment`, `reflection`, `consolidat`, `reviewer`, `claim`, `lens`, or
`candidate`. Identifiers split on camelCase as well as underscores, so `Claim`
is caught and `WebPreviewError` is not. No SQL in those files may name a
research table, in a query or in a migration.

Comments and docstrings are deliberately outside the law: prose explaining why
support carries something research-shaped is how the boundary stays
understandable to the next reader.

The law admits an allowlist, and every entry carries the reason it cannot be
fixed where it is written. Today: `lens_id`, a public wire field of
`artifact.upload` with the relay shapes behind it, whose value Artifacts never
reads. `experiments.rapidreview.io` is a DNS name, not vocabulary. Two files are
outside the scan: the composition roots (`surface/surface.py` and
`surface/transport/api/app.py`), whose job is naming every owner. A test fails
the moment an allowlist entry stops matching anything.

Where the kernel used to name research fields, owners now register them.
`kernel/state/activity.py` keeps the generic argument names every component
carries and exposes `register_activity_vocabulary`; Research declares its
capability, its ids, and the records they name, and Surface registers that
before it builds anything that can log.

## Persistence ownership

Every component declares the tables it reads. Kernel supplies the registration
API — a `SchemaModule` carrying idempotent DDL plus any numbered `Migration`
steps above the baseline, installed through `BaseStateStore.install` — and
keeps only what everything writes through: projects, membership, events, the
tool-call ledger, tenants, and `schema_migrations`. Every other table is
declared in a `persistence` module beside the service that uses it (Surface
splits its own across the flows that own them), and Surface installs each
component's schema as it constructs the component. Dialect translation stays in
Kernel, so SQLite and Postgres reach an identical shape.

The DDL is the whole shape, not a starting point. Versions 1..64 were squashed
into it once production and every other live database had reached that head, so
an index or a view a step used to create is declared beside the table it names.
A fresh install records `(64, "baseline")` and applies only what is above it;
migration numbering above the baseline stays global so one ledger orders every
step, and a step whose owner has not installed yet is skipped and converges on
a later install.

`TABLE_OWNERS` in the boundary test is authoritative in both directions: a
table's `CREATE TABLE` must live in its owner's schema module, an unowned new
table fails closed, and a stale entry must be deleted. Runtime SQL may name
only its own component's tables, Kernel tables, and tables behind a ratified
component edge — and the Kernel store's own SQL now names nothing but Kernel
tables: projects, project_members, events, schema_migrations.

## Tool contracts

`ToolContract` lives in `kernel/tools.py`, so a component can declare its tools
without importing delivery. Each owner exports a `TOOLS` table from its package
root; `surface/tools/contracts.py` merges those tables in a fixed order,
asserts unique names, and keeps the few Surface itself owns: `agent.hello`, the
merged `project` tool, and the internal `project.get`/`list`/`update` the UI
reads.

The gateway names no tool. What it must inject is declared on the contract by
the tool's owner: `binds_producer_session`, `binds_capability`,
`binds_caller_project`, `telemetry_scope_field`, `needs_base_url`,
`external_key_denied_action`. What a leased session may
call is the support baseline in `transport/http_policy.py`
(`SESSION_READ_BASELINE`, plus `SESSION_WRITE_BASELINE` when the node is not
read-only) united with the tools that node's `Execution` declared. Scope checks
compare an argument against the leased instance id or a reference the packet
carried, by field name the node supplied.

## Cross-package law

Brain code may import pure `merv.shared` contracts: error identities, tool-shape
validation, storage transfer and guidance, feed-media primitives, shell-command
rendering, markdown-image parsing, machine directories, the trace-excerpt
redactor. Shared imports only the standard library and itself. The client
(runner, CLI, harness) imports the standard library and `merv.shared`, never
`merv.brain`. Research vocabulary is not shared: artifact
roles and association targets live in
`workflows/definitions/artifact_roles.py`, document summaries and experiment
folder naming in `research_core`.

## Keeping it small

Total source lines go down. A change that adds them justifies every added
block: prefer deleting a mechanism to adapting it, never keep a compatibility
shim nobody asked for, do not add a second dataclass or helper beside an
existing one, and fold verbose validation into the type that owns it. Tests
grow only where a new behaviour exists; a test of a removed mechanism is
deleted with it. `git diff --shortstat <base>..HEAD -- merv/src` is the check.

## Executable ratchets

`tests/structure/` AST-scans the tree rather than trusting prose. Beyond the two
laws above it holds: cross-component imports enter a public entrypoint; no
Artifact-table SQL outside Artifacts (zero baseline); Surface delivery names no
internal implementation, reaches through to no store, transaction or cursor, and
receives no whole-app carrier; boundary value objects round-trip as JSON
primitives; every tool is a control tool the brain can serve; no brain-owned
policy module depends on a checkout, a process, or local IO; the record store
never learns a `repo_root`.

Each component also keeps a design note beside its code, at
`brain/<component>/<component>.md`: agent_sessions, application, artifacts,
feed, research_core, surface, workflows. A note must stay accurate and under
100 lines; the header comment on each source file says when to revisit one.
