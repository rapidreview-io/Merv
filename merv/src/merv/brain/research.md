# Reading Merv: one experiment, end to end

Every native research record — experiment, task, reflection — runs on the same
machinery, so read the experiment once and you have read all three. This walks
one experiment through the code in the order it executes, naming each file once.
`docs/MODULE_BOUNDARIES.md` is the component map, and each component's own note
(`research_core.md`, `workflows.md`, `application.md`, `surface.md`) is the
detail behind a step here.

## 1 Declaration — what an experiment is

`workflows/definitions/experiment.py` holds the whole thing as data: a
`Workflow` of nodes and edges; one `RecordKind` binding it to the experiments
table — insert columns, per-action commit columns, sealing exemptions, a typed
constructor, and `Public`, the hidden fields and public names the serializer
reads; and each node's `requires`, the `ArtifactNeed`, `RecordNeed`,
`DependenciesDone` and `ReviewGate` gating its outgoing edges. Nothing
downstream restates this machine — `action:experiment.approve_design` and its
siblings are read off this file, whose state values sit beside it in
`workflows/definitions/research_state.py`.

## 2 Program — what a brain installs

`programs/research.py` names the graphs, record kinds, effect names, requirement
classes and tool table Merv runs on, plus its project orientation. Bootstrap
installs programs, not parts, and `programs/` is the only place in the tree that
names a definition module.

## 3 Engine — one interpreter for every kind

`research_core/records.py` is the engine that `RecordKind` is data for: it
creates a row on the caller's transaction after checking the kind's creation
facts, hydrates a project's records with one read per child table, evaluates the
gate, and commits a transition's native columns, sealing and hooks. No per-kind
engine sits underneath it.

## 4 Runtime — the durable half

`workflows/runtime.py` owns the instance rows. Every action carries the revision
it expects: the runtime fences it, short-circuits an idempotent repeat,
evaluates the graph, applies the edge's `Change`, saves state and queued
actions, commits the native record, enters composed children, and appends
immutable history with the event. `workflows/workflows.py` is the public root
holding the registry and the bindings Research supplies to it.

## 5 Hooks — what a declaration cannot say

`research_core/experiments.py` is the experiment's `RecordHooks`: active cap,
reserved wave names, reflection debt, claim links, the attempt clock and the
metrics exhibit. `research_core/reflections.py` and `research_core/reviews.py`
do the same for their kinds. A hook earns its place only where it answers a
question a declaration cannot ask.

## 6 Effects — inside the transaction, or after it

An edge's `Change` carries both kinds. A `TransactionalEffect` runs on the same
connection before the native commit, so a failure rolls the entire transition
back. An `Action` is queued with the committed event and delivered afterwards by
`workflows/delivery.py`, which retries under a stable key and a fenced lease,
and stops polling on a permanent failure.

## 7 Facts and gates — why an edge is blocked

`research_core/policy.py` is pure: one resolver per requirement class in
`RESOLVERS`, each formatting one checklist item from the same verified facts the
runtime enforced on. A review gate reads one project- and snapshot-scoped fact —
latest verdict, independence, request status, validity, expiry — assembled once
in `research_core/reviews.py` and shared by runtime and checklist, so the
explanation can never disagree with the edge.

## 8 Presenters — the read models

`application/workflow.py` joins record state, gate evaluation and workflow
presentation into the rich UI view and the slim agent view;
`application/reviews.py` does the review handoff. Application composes what the
components own and holds no state itself.

## 9 Wire — how a caller reaches it

`surface/tools/contracts.py` merges every owner's tool table into one manifest,
and the gateway injects only what each contract declared it needs.
`surface/transport/api/experiments.py` is the HTTP face: its writes go through
those same tools, its reads through the presenters above. Both are delivery:
neither decides anything.

## 10 Where to change what

- A new state, edge, gate or public field: `workflows/definitions/experiment.py`
  alone. Never add a branch downstream to compensate for one missing here.
- A new kind of gate: a `Requirement` class beside its graph, plus its one entry
  in `RESOLVERS`.
- Something only the database can answer: that kind's `RecordHooks`.
- A new review path: `workflows/definitions/review.py` declares the graph, and
  `research_core/reviews.py` owns capability, independence and return routing.
- A new tool or route: the owner's tool table first, the router second. Support
  carries the id it is given and never interprets it.

Keep under 100 lines; qualify named actions, roles, tools and skills inline.
