# Workflows

This package separates workflow definitions, durable execution, and composition.
Projects, claims, artifacts, agent processes, and cloud infrastructure remain
outside it. Python functions own workflow gates, transitions and agent context.

`graph.py` defines immutable nodes, ordinary directed edges and one `Evaluation`
for command enforcement, available/blocked actions, guidance and dispatch.
Branches, loops and review rejection use the same transition model. Agent nodes
provide `build_context(snapshot, knowledge) -> Brief`, with a concise assignment
and exact evidence references. Wait and terminal nodes dispatch no agent.

Every agent node declares an `Execution`: whether it is read-only, its
node-specific tools beyond the support baseline, the `mutating` subset, `Scope`
rules binding arguments to the instance id, the workflow name, or a brief
`Reference` by kind, sandbox authority, and the runner `WorkspacePolicy` layout (mode,
namespace, base, per-base branches, retention, central advance). Research
declares; support enforces. The gateway verifies a present scoped argument and
binds the resolved value into the handler call for mutating tools and for tools
whose contract declares the field, so every mutating tool must accept its scoped
fields as keywords. `definitions/execution.py` holds the shared vocabularies.

`persistence.py` declares the three tables this package owns: instances,
history, and the action outbox.

`runtime.py` stores version-pinned instances, immutable history and requested
actions. It enforces revision checks and idempotent request keys, records actual
work activation separately from state transitions, and calls transactional native
record bindings. It provides a final revision/prerequisite fence for the actual
assignment lease transaction, and answers Agent Sessions' `InstanceFacts` port
(revision, terminal, label) so leases never read a research table. The
assignment packet carries `execution` as the node's declared policy in JSON.
`delivery.py` retries effects using stable keys and expiring leases; an
obsolete worker cannot acknowledge a newer worker's lease.

`composition.py` describes child workflows by name and named entry, or attaches
existing instances without changing their progress. Wait nodes pin membership
and join named outcomes. `join_guard` enforces the same route for manual commands
and automatic joins. Old child generations cannot resume a new wait. Version
migration explicitly preserves or replaces children and never replaces live work.

`definitions/` contains experiment, task, reflection, independent reflection lens,
and published research-wave graphs. It also owns pure evidence validators,
context builders, research contracts and passive legacy presentation metadata.
`artifacts.py` there pins arbitrary semantic labels to immutable content IDs;
new plugins need no storage role vocabulary or native research record.
`artifact_roles.py` holds Merv's own role and association-target vocabulary
with per-role byte caps; Research, Application and Surface import it through
this package root, and support components never do.

`workflows.py` is the public root. Its explicit registry keeps every deployed
version. Optional bindings supply read-only verified facts and transactional
native record writes. Common project and immutable artifact readers are composed
by Surface. Application delivers review and child-start actions through
support-system public roots. Merv artifacts remain in Merv-owned R2; the sandbox
service owns ML compute and workload storage only.

Generic MCP tools expose catalog/start/status/assignment/begin/transition/history;
`tools.py` owns their contracts and the support registry merges that table.
Existing native tools use the same runtime. Auto-run activation and interactive
`workflow.begin` start clocks/actions only when work starts; merely approving a
plan or reading a context does not. Dispatch owns identities and leases, then
supplies the node's frozen brief, references and execution policy to the runner.
The consolidating node references the retained proposal's base as `code`, which
its per-base workspace builds on.

Schema 60 adopts existing native states, evidence and valid assignments. Explicit
bootstrap preserves completed lenses and reviews, and attaches the existing
published wave. Registered definition changes require explicit instance migration.

See `docs/WORKFLOW_IMPLEMENTATION.md` for composition, persistence and upgrade
behavior. Keep this document under 100 lines and keep workflow decisions here,
not in support systems or presentation adapters.
