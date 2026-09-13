# Workflows

A Cordis service for durable, project-scoped declarative state machines. It depends
only on `state` and `scope`; it has no artifact, review, or task dependencies.

Install `workflowsPlugin` after (or before) its providers. Cordis activates it when
both services are available. The optional `workflowToolsPlugin` also requires
`tools` and exposes only `workflow.list`, `workflow.get`, `workflow.history`, and
`workflow.catalog`.

## Installing a program

```ts
import type { Context } from 'cordis'
import '@merv/contracts'

export const approvalProgram = {
  name: 'approval-program',
  inject: ['workflows'],
  apply(ctx: Context) {
    ctx.effect(function* () {
      const program = ctx.workflows.register({
        name: 'approval', version: 1, managed: true,
        initial: 'draft', states: ['draft', 'done'], terminal: ['done'],
        edges: [{ from: 'draft', action: 'accept', to: 'done' }],
      })
      yield () => program.dispose()
      // Register program commands that perform domain checks, then use
      // program.start(caller, input, tx) / program.transition(caller, input, tx).
    })
  },
}
```

The registration handle owns exactly one name/version. With `managed: true`, the
public engine mutation methods reject that graph, preventing generic workflow
commands from bypassing program rules. Managed transitions validate project access;
the program must authorize its specific action (for example `write` or `review`).
Unmanaged graph mutations require `write` permission directly.

## Durability

- A name/version has a persisted fingerprint. Changed graph definitions must use
  a new version, including after restart. Instances remain pinned to their version.
- Starting without a version chooses the latest installed version. Retrying that
  request returns the original response even if a newer version was installed.
- Request IDs are scoped to the project. Reuse requires identical actor and command
  content; replay returns the original snapshot, not the current instance state.
- Every mutation commits instance state, command response, history, and its durable
  event together. Revision mismatches fail without creating a command response.
- Pass a State-owned active `Transaction` to combine workflow changes with another
  component's records. The transaction must remain synchronous.
- Registration disposal stops new execution of its graph. It does not delete
  definitions, instances, history, or request receipts. Reads remain available;
  reinstalling the same version resumes operations. Explicit old handles stay invalid.

The current engine deliberately supports transitions and JSON data merging. It does
not yet implement child graphs, automatic effects, timers, or live version migration.
Programs can coordinate domain work through one caller-owned transaction.
