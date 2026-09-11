# Workflows

This package separates workflow definitions, durable execution, and composition.
Projects, claims, artifacts, agent processes, and cloud infrastructure remain
outside it. Python functions own workflow gates, transitions and agent context.

`graph.py` defines immutable nodes, ordinary directed edges and one `Evaluation`
for command enforcement, available/blocked actions, guidance and dispatch.
Branches, loops and review rejection use the same transition model. Agent nodes
provide `build_context(snapshot, knowledge) -> Brief`, with a concise assignment
and exact evidence references. Wait and terminal nodes dispatch no agent.

A node also declares what its state needs, as `requires`: `ArtifactNeed` (a submitted
document, selected and validated), `RecordNeed` (a fact its own graph function verifies),
`DependenciesDone`, `ReviewGate`, and whatever class a program brings. Each names the edges
it gates and whether it also blocks dispatch, so the runtime raises its issue there instead
of a hand-written edge check, and Research reads the same declaration for the gate
checklist. A check survives only where it says something a requirement cannot — a rejection
verdict, a lens roster, an abandon guard. `RecordKind` declares the native row a graph is
bound to: table, id prefix, insert and JSON columns, per-action commit columns, seal
exemptions, any status projection, and `Public` — what a reader of that row never sees, what
a stored column is called, and where a computed field sits. It also answers what its own
graph already says: the success status, the actions, which action carries an effect, and the
review gates and returns, so nothing restates a state machine. A plugin workflow declares no
kind and keeps its record in instance data. `Program` names what a brain installs — graphs,
kinds, the effect kinds its edges emit, the requirement classes its nodes use, its tool
table — and validates them at import; `requires` is a `Requirement` protocol, so a program
may bring its own need class. `brain/programs/` holds the programs and `INSTALLED`, the only
place a definition module is named.

Every agent node declares an `Execution`: whether it is read-only, its node-specific tools
beyond the support baseline, the `mutating` subset, `Scope` rules binding arguments to the
instance id, the workflow name, or a brief `Reference` by kind, sandbox authority, and the
runner `WorkspacePolicy` layout (mode, namespace, base, per-base branches, retention,
central advance). Research declares; support enforces. The gateway verifies a present scoped
argument and binds the resolved value into the handler call for mutating tools and for tools
whose contract declares the field, so every mutating tool must accept its scoped fields as
keywords.
`definitions/execution.py` holds the shared vocabularies.

`persistence.py` declares the three tables this package owns: instances,
history, and the action outbox. `runtime.py` stores version-pinned instances, immutable history and requested actions. It
enforces revision checks and idempotent request keys, records actual work activation
separately from state transitions, and calls transactional native record bindings. It
provides a final revision/prerequisite fence for the assignment lease transaction, and
answers Agent Sessions' `InstanceFacts` port (revision, terminal, label) so leases never
read a research table. The assignment packet carries `execution` as the node's declared
policy in JSON.
`delivery.py` retries effects using stable keys and expiring leases; an
obsolete worker cannot acknowledge a newer worker's lease.

`composition.py` describes child workflows by name and named entry, or attaches existing
instances without changing their progress. Wait nodes pin membership and join named
outcomes. `join_guard` enforces the same route for manual commands and automatic joins. Old
child generations cannot resume a new wait. Version migration explicitly preserves or
replaces children and never replaces live work.

`definitions/` contains experiment, task, reflection, independent reflection lens, and
published research-wave graphs, each beside its `RecordKind`, plus pure evidence validators,
context builders, research contracts and the passive legacy `Metadata` (action effects and
how a subject is named).
`reflection_corpus.py` states what a wave reads — its fixed corpus, the content
hydration behind it, consolidation coverage and the project-graph diff — as pure
functions over rows and submitted bytes, so the record service asks only the
questions a database answers.
`documents.py` declares one model per research document and validates from it; only what
a schema cannot say stays code, each a named rule — cycles, uniqueness across entries,
references resolved through a caller's callback, and research tool inputs import those
models instead of restating them.
`artifacts.py` there pins arbitrary semantic labels to immutable content IDs, so new
plugins need no storage role vocabulary or native research record.
`artifact_roles.py` holds Merv's own role and association-target vocabulary with
per-role byte caps; Research, Application and Surface import it through this package
root, and support components never do.

`workflows.py` is the public root. It builds its registry from the installed programs and keeps
every deployed version. Optional bindings supply read-only verified facts and transactional
native record writes. Common project and immutable artifact readers are composed by Surface.
Application delivers review and child-start actions through support-system public roots. Merv
artifacts remain in Merv-owned R2; the sandbox service owns ML compute and workload storage
only.
Generic tools include `tool:workflow.catalog`, `tool:workflow.start`,
`tool:workflow.status_and_next`, `tool:workflow.assignment`, `tool:workflow.begin`,
`tool:workflow.transition` and `tool:workflow.history`;
`tools.py` owns their contracts and a program carries that table into the registry. Auto-run
activation and interactive `tool:workflow.begin` start clocks/actions only when work starts;
merely approving a plan or reading a context does not. Dispatch owns identities and leases,
then supplies the node's frozen brief, references and execution policy to the runner. The
consolidating node references the retained proposal's base as `code`, which its workspace
builds on.
Schema 60 adopts existing native states, evidence and assignments; bootstrap preserves
completed lenses and reviews and attaches the published wave. A registered definition
change requires explicit instance migration; duplicate registrations fail and requirements
may gate only outgoing actions of their declaring node. Review facts are scoped to project, snapshot
and role; Research reviews reads SQL/settings and pure policy formats the same fact
for checklists and runtime, including request expiry and independence. Permanent effect
failures wait for project-scoped `Deliveries.retry`; transient failures retain backoff.
Keep this note under 100 lines; qualify named actions, roles, tools and skills inline.
