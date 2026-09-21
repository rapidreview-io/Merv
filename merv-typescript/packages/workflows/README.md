# Workflows

A Cordis service for durable, project-scoped declarative state machines. It depends
only on `state` and `scope`; it has no artifact, review, or task dependencies.

Install `workflowsPlugin` after (or before) its providers. Cordis activates it when
both services are available. Its tool adapter exposes `workflow.status_and_next`
for caller-specific gate guidance or a project overview. Programs such as Tasks
register their checks and retain their own commands. Trusted in-process code can
also inspect the engine through its catalog, get, list and history methods; those
four generic tools remain unexposed.

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
Unmanaged graph mutations require `write` permission directly.

## Durability

- A name/version has a persisted fingerprint. Changed graph definitions must use
  a new version, including after restart. Instances remain pinned unless their owning program explicitly upgrades them.
- Starting without a version chooses the latest installed version. Retrying that
  request returns the original response even if a newer version was installed.
- Request IDs are scoped to the project. Reuse requires identical actor and command
  content; replay returns the original snapshot, not the current instance state.
- Every mutation commits instance state, command response, history, and its durable
  event together. Revision mismatches fail without creating a command response.
- Pass a State-owned active `Transaction` to combine workflow changes with another
  component's records. Await every operation, including domain callbacks, before the transaction returns.
- Registration disposal stops new execution of its graph. It does not delete
  definitions, instances, history, or request receipts. Reads remain available;
  reinstalling the same version resumes operations. Explicit old handles stay invalid.

Managed registration handles also support `upgrade` to a newer version of the same
workflow when the graph only adds edges: initial state, state names, terminal states
and all prior edges must remain unchanged. The source and target registrations
must both be active. Upgrades require write access, reject terminal instances,
advance the revision, and record source/target versions in history. They preserve
state/data and can share the program command’s transaction. This is not a general
state-mapping or bulk migration facility.

The engine does not yet implement child graphs, automatic effects or timers.
Programs can coordinate domain work through one caller-owned transaction.

## Dependencies between work items

The service also owns project-scoped dependency edges. Programs declare durable
`successStates` in policy and can pass `dependsOn` at start. `dependencies` returns
live forward/reverse rows; `checkDependencies` is the shared prerequisite guard.
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
