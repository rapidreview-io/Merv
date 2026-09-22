# Continuous research

Tasks and experiments finish → reflection → the consolidation task, when main lacks accepted code → the approved next wave.

On **Work → New cycle**, select the work and enable **Continue automatically through reviewed research waves**. Choose a maximum cycle count (default 10, including the first cycle). Existing cycles and API calls that omit automatic mode remain manual. New cycles use `research@6`; historical versions retain their original rules.

The equivalent tool input is:

```json
{
  "name": "Test the available data",
  "dependsOn": ["TASK_OR_EXPERIMENT_ID"],
  "automatic": true,
  "maxCycles": 10,
  "requestId": "start-continuous-research"
}
```

The project definition still needs problem, scope, goals and constraints. Automatic mode requires at least one selected task or experiment. Worker execution still requires a configured Runner and enabled Sessions dispatch; creating a cycle does not launch processes itself.

## Handoffs

Research consumes existing durable workflow events. It checks the same workflow guidance as a manual advance, then calls the same domain command with a stable request ID. No additional agent, scheduler plugin or worker permission is introduced.

- **Defining:** pin the complete project definition and enter researching.
- **Researching:** wait for all selected work to finish, including failed and abandoned work, then create the five-lens reflection.
- **Reflecting:** wait for independent approval. Where the project is not hosted by Code, complete this cycle and apply the approved next-wave decision. Where it is, whether main lacks accepted code is Git's answer, given outside a transaction; the consumer's transaction cannot ask, so the cycle shows `integration_candidates_unavailable` until the owner advances it from a client, which injects the consolidation task or completes the cycle.
- **Consolidating:** wait for the consolidation task to be accepted and published. `dependencies_pending` and `publication_pending` are waits recorded as the cycle's blocker, never failures, and cost no cycle; a published task completes the cycle and applies the next-wave decision. A stale publication or a task ended without acceptance is likewise a visible wait for the owner's advance.
- **Continue:** create the approved tasks, experiments and successor in the existing transaction. The successor inherits the original authority and cycle limit, and starts from main.
- **Stop:** complete without a successor. At the cycle limit, finish reflection and any consolidation, then complete without creating more work. The approved proposal remains retained.

Automatic reflections require an `application/json` change specification with an explicit continue/stop decision. This requirement is in their frozen assignment and checked by both submission and preflight. Manual and standalone reflections still accept prose. Independent reviews and return paths are unchanged.

A successor automatically accepts the preceding definition only if its revision is unchanged. If the owner edited it, automatic work waits for an explicit `research.advance` in defining; the Work page offers **Accept changed definition**. Ending a cycle stops further handoffs; already-created children keep their own lifecycles.

## Failed work is an outcome

Versions 5 and 6 use the selected work as the wave's subject, not as a success requirement. Completed, failed and abandoned records remain in the selection, evidence inventory, lineage and digest. Reflection approval and the consolidation task's publication govern later stages; the old failed experiment cannot block the cycle again.

Execution dependencies still require successful inputs. Before opening reflection, automatic Research closes selected, never-started work whose required input has terminally failed. A task is marked failed; an experiment is abandoned. The retained reason starts with **Not run: required input ended without success**, identifies the input, and names the research wave. The closure repeats through the selected chain, including chains listed in reverse order.

Only the selected work is eligible for this cleanup. Started work, reviews, unselected work, missing inputs and merely pending prerequisites are not automatically ended. Existing domain ownership rules still authorize each ending. A refusal is visible on the cycle; it does not grant the coordinator authority over somebody else's work.

## Durability and authority

Research stores the original delegation (actor credential, machine key or human membership) privately and revalidates its current write authority before each action. It never stores a bearer token, exposes the delegation through `research.get`, or converts a leased worker into an owner. Leased workers still cannot create or advance research cycles. An automatic successor can be created only by the authorizing owner, including when a manual advance is used.

The durable consumer resumes its cursor across restarts. Startup and provider restoration also enqueue a reconciliation event, so a previously observed blocker is retried when its provider returns. Each cycle's effects are isolated in a savepoint inside the consumer transaction. Expected domain refusals roll back that cycle's partial effects and save a readable blocker; unexpected errors roll back the event and retry. One blocked cycle does not stop other authorized cycles from advancing.

The cycle's `automation` read model exposes its root, cycle number, maximum cycles and current blocker. Source credentials are never returned. `research.automatically_advanced`, `research.blocked_work_closed` and `research.automatic_status` preserve system attribution alongside the original owner and existing workflow history.

The cycle cap covers this automatic chain. Existing session budgets and review limits continue to apply. This change does not add live cost accounting or cross-machine code transport. A consolidation task publishes to main through the same pull request and operator merge as any unit marked to publish.

## Verification

`tests/research-automatic.test.ts` exercises real Tasks, Experiments, Reflections, Reviews, Research, Workflows and Domain Events: all-failed waves, dependency cleanup, independent rejection/revision/approval, two-wave continuation, limits, restart recovery, partial-handoff rollback, revoked authority and the assembled plugin lifecycle. `tests/ui-tasks.test.ts` checks the creation control and selection of failed work.
