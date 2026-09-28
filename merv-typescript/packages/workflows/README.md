# Workflows

A Cordis service for durable, project-scoped declarative state machines. It depends
only on `state` and `scope`; it has no artifact, review, or task dependencies.

Install `workflowsPlugin` after (or before) its providers. Cordis activates it when
both services are available. Its tool adapter exposes six tools:
`workflow.status_and_next` (caller-specific gate guidance, or a project overview),
`workflow.catalog`, `workflow.assignment`, `workflow.process`, `workflow.begin` and
`workflow.extend_limit`. Programs such as Tasks register their checks and retain their
own commands. `get`, `list` and `history` are in-process methods only; no tool exposes
them.

`await register(definition, policy)` registers awaited domain checks, action/tool
descriptions and optional argument/reference builders. `evaluate` returns the
current decision and supports read-only action preflight; `overview` evaluates all
instances in the caller's project and sorts them into `ready`, `blocked`, `stalled`,
`escalated`, `terminal` and `unavailable`. A supplied policy must guard every graph edge.
A policy may also declare `limits` on its loop edges: they are deployed policy rather than
fingerprinted graph, are counted from history, refuse the capped edge at commit with
`loop_limit_reached`, and are raised for one instance by `extendLimit`
([loop limits](../../docs/BUDGETS_AND_LIMITS.md)). Its optional `children` callback names
instances it fans out to without a dependency edge, which `dependencyClosure` unions in.
The same checks run before a transition commits. See [the complete contract,
task integration and lifecycle behavior](../../docs/WORKFLOW_GUIDANCE.md).

## Installing a program

```ts
import type { Context } from 'cordis';
import '@merv/contracts';

export const approvalProgram = {
  name: 'approval-program',
  inject: ['workflows'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const program = await ctx.workflows.register({
        name: 'approval',
        version: 1,
        managed: true,
        initial: 'draft',
        states: ['draft', 'done'],
        terminal: ['done'],
        edges: [{ from: 'draft', action: 'accept', to: 'done' }],
      });
      yield () => program.dispose();
      // Register program commands that perform domain checks, then use
      // await program.start(caller, input, tx) / await program.transition(caller, input, tx).
    });
  },
};
```

The registration handle owns exactly one name/version. With `managed: true`, the
public engine mutation methods reject that graph, preventing generic workflow
commands from bypassing program rules. Managed transitions validate project access;
the program must authorize its specific action (for example `write` or `review`).
Unmanaged graph mutations require `write` permission directly. A registration handle's
`addDependencies` follows the same rule: `read` on a managed graph, `write` otherwise.

## Durability

- A definition keeps only each edge's `from`, `action` and `to`. Edges may not use the
  actions the engine records itself (`start`, `add_dependencies`, `replan_dependencies`),
  and a graph may have at most 256 states and 2,048 edges.
- A name/version has a persisted fingerprint. Changed graph definitions must use
  a new version, including after restart. An instance stays on the version it started on.
- A version's stored definition, success states and execution policies are immutable: the
  database refuses an UPDATE or DELETE of any of them. The service therefore loads them all
  at startup and keeps them. It reads a version it does not hold, such as one another service
  registered later, only once, unless that version still lacks its success row or an
  execution row for a nonterminal state, which a later registration would add.
- Starting without a version chooses the latest installed version. Retrying that
  request returns the original response even if a newer version was installed.
- Start data, transition data and input, and preflight input are each a JSON object of
  at most 256,000 encoded characters, 16,000 values and 32 levels of nesting; anything
  larger is `invalid_data` 400. The merged instance data is not capped.
- Request IDs are scoped to the project. Reuse requires identical actor and command
  content; replay returns the original snapshot, not the current instance state.
- Every mutation commits instance state, command response, history, and its durable
  event together. Revision mismatches fail without creating a command response.
- Pass a State-owned active `Transaction` to combine workflow changes with another
  component's records. Await every operation, including domain callbacks, before the transaction returns.
- Registration disposal stops new execution of its graph. It does not delete
  definitions, instances, history, or request receipts. Reads remain available;
  reinstalling the same version resumes operations. Explicit old handles stay invalid.

## Retired versions

A version that no current flow can start is retired: its program stops registering it and a
migration deletes its instances with every row keyed by them. The 2026-09-22 retirement
(task@1, experiment@1–4, reflection@1–2 and lens@1, research@2–5, consolidation, evidence
version 1, review format 1 and the `experiment.plan@1` recipe) also removed the engine's
`upgrade` primitive, which only task@1 used. On 2026-09-25 the `experiment.plan` task type went
the same way (workflows migration 8 deletes its task instances). The definition, success and
execution-policy rows of a retired version stay as history.

Workflows owns the ledger of that retirement, `wf_retired_instances` (id, project, workflow,
version, reason). Every component migration that deletes retired records first runs the shared
snippet in `@merv/contracts/retired-instances`, which fills the ledger insert-only; whichever
runs first captures the whole set while its inputs still exist, and the rest read it. A guard
refuses any update or delete of it, because once `wf_instances` has lost the retired rows the
set could not be computed again. The ledger is kept permanently: it explains the ids the
`events` log still names, which is never rewritten. The snippet then refuses the release while
deleting the set would strand a surviving record: a live session of a retired instance, a
surviving research cycle staged on a retired wave, a format 1 review of a survivor, or graph
evidence of a surviving experiment. Every retirement migration runs it before its deletes, so
the first to run refuses before any component commits and the previous image still boots. The
snippet's text is embedded in published migrations and may not change.

The engine does not yet implement child graphs, automatic effects or timers.
Programs can coordinate domain work through one caller-owned transaction.

## Dependencies between work items

The service also owns project-scoped dependency edges. Programs declare durable
`successStates` in policy and can pass `dependsOn` at start. The first registration
of a version pins its success states, or their absence; a later registration that
adds, drops or changes them is `workflow_version_conflict`. `dependencies` returns
live forward/reverse rows, each with its revision and whether it is `settled`, `terminal`
(ended, as a fact) or `failed` (ended in a way that fails the dependent; a provider's edge
never is); `checkDependencies` is the shared prerequisite guard. Guidance, the guard and
transitions read only what an instance depends on, in a fixed number of queries; what depends
on it is read only when asked for. Attaching at start never walks the graph, because the new
id cannot be reached; `addDependencies` and a provider's `replace` refuse a cycle with one
recursive query, after every named target has been found and checked in the order given.
Only actions with `requiresDependencies: true` enforce that guard automatically.
Programs call it for assignment/execution gates as needed. A policy may name an
authorized `dependencyFailureAction`; this changes guidance, never state.

Private registration handles support additive, revision-fenced `addDependencies`
for transactional program composition. Edges reject cycles and cross-project
references and pin the target’s success contract. Legacy workflow definitions,
receipts and graph versions remain unchanged. See [the full behavior and limits](../../docs/WORK_ITEM_DEPENDENCIES.md).

## Assignments and first starts

Programs register per-state assignment checks and builders alongside action rules. `assignment` is read-only; `begin` rechecks admission and current revision, records the first activation and returns the complete packet in one transaction. Guidance exposes a preflightable begin action without rendering context. `workStarts` provides scoped durable history across program unload; begin itself does not transition or claim work. See [the integrated contract](../../docs/WORKFLOW_ASSIGNMENT_PLAN.md).

## Fixed execution declarations

Assignment rules may also declare a fixed `execution` policy and a metadata-only
`references` resolver. `execution(caller, target, tx?)` returns the current policy
and bindings; `authorizeDispatch(caller, dispatch, tx?)` checks a proposed tool
against them without building context. Policy hashes are pinned per version and
state, including explicit absence. Registration generations fence unload/reload
and restart. These internal checks do not create session credentials or restrict
ordinary keys. See [the contract and next integration boundary](../../docs/WORKFLOW_EXECUTION.md).

## Leased execution

`dispatchCandidates(source, tx?)` discovers eligible leased assignments using
source/domain admission and metadata only. It checks prerequisite and recipe
availability without rendering prompts, resolving reference values or recording
work starting. Sessions still rechecks the selected revision before reservation.
Read-only work sorts first. An optional `lease.label` callback supplies a small
queue label without calling the assignment builder.

An assignment's fixed `execution.workspace` declaration specifies scratch,
ephemeral or persistent checkout intent. Omission preserves old policy hashes
and means scratch through `effectiveWorkspace()` from Contracts. Workspace
provisioning and reference resolution belong to the future machine runner.
See [the scheduling and workspace contract](../../docs/RUNNER_CONTROL_PLANE.md).

Programs can supply generic assignment lease hooks to acquire, check and release
their own ownership records. `offerLease` returns a frozen assignment, execution
policy and opaque receipt. `activateLease` records first-start using metadata only.
`checkLease` admits a durable lease against the current installed generation;
`authorizeLeaseDispatch` separately fences a captured invocation generation and
uses frozen inputs plus explicitly owned outputs. Sessions owns credentials,
expiry and source authority; Workflows still has no dependency on Sessions, Tasks,
Reviews or artifact storage. See [the integrated contract](../../docs/SESSION_LEASES.md).

## Conventions

**Authority.** A caller method authorizes its caller through Scope: reads need `read`;
a handle's commands need `read` on a managed graph, where the program authorizes the
action itself, and `write` otherwise; `extendLimit` needs `admin`. The trusted provider
seams (`replaceBlockers`, `systemPrerequisites(provider).replace`, `dependencyRelations`,
`sponsoringRoots`) take a `projectId` and the caller's `tx` and authorize no caller: only
in-process code reaches them. A lease step authorizes its worker at entry.

**Transactions.** A method given a `tx` asserts that it belongs to State and runs in it;
otherwise it opens its own transaction, which is read-only inside a `state.snapshot`.

**Callbacks.** Every program callback (guards, `describe`, lease hooks, builders) is
awaited in the engine's transaction and must not write to `wf_instances`: after each
group of callbacks the engine rereads the instance, refuses it as
`invalid_workflow_policy` 500 if it reads differently (a rewrite to equal values is not
seen), and rechecks the caller's authority and the registration.
A guard's refusal is read as a blocker; a State fault (`read_only_scope`,
`nested_transaction`, `transaction_*`, `state_*`) never is, and a write under a read is
`invalid_workflow_policy` 500.

**Lease hooks.** `lease.role` answers for the source, at discovery and at offer, whether
the node may be leased now and which role its worker needs; it never runs once a lease
exists. `lease.check` answers for the worker, at offer and on every admission for the
lease's life, whether the program's reservation (its receipt) still holds. Source
admission belongs in `role`, reservation validity in `check`.

**Dependencies.** A dependency's `failed` is a gating fact: a declared edge whose target
ended outside its pinned success states fails its dependent. A system edge, which a
provider owns, always reads `failed: false`, because its provider replans it. A handle's
`addDependencies` is a command: it records history and bumps the revision, so a lease
pinned to the old revision ends. A provider's system edges bump nothing.

**Blockers.** A provider's blockers stay on an instance across non-terminal moves until
the provider replaces them; they are cleared when the instance reaches a terminal state.

**`dependencyClosure`** walks at most 5,000 instances and refuses a larger closure with
`closure_too_large` 409 rather than return part of it.

**Read schema.** Other components may read these columns directly and nothing else:
`wf_instances(id, project_id, workflow, version, state, revision, data_json, created_at,
updated_at)` and `wf_history(instance_id, project_id, revision, action, actor_id,
request_id, from_state, to_state, data_json, created_at)`. `data_json` of an instance is
its merged data. `data_json` of a history row depends on its action: the start data for
`start`, the delta a transition merged for a program action, and `{dependsOn, dropped}`
for `add_dependencies` and `replan_dependencies`, which leave the instance data unchanged.
Only the engine writes either table.
