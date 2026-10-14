# Compute as an assignment capability

## In-process integration

Merv loads the pinned Sandboxes library against the standalone service's database. Standalone owns
workers, gateway, API/MCP and console. The `packages/sandboxes` integration plugin issues and retires
runs and projects captures as immutable artifact collections under `sbx-evidence`. Merv records run
scope before issuance: session close retires a run, an epoch change retires the old attempt, and
terminal work releases its resources. The shared Sandboxes services own object retention and signing.
Tasks and Experiments read capture receipts through `sandboxEvidence` inside their Merv transactions;
the integration calls Sandboxes outside those transactions. `@merv/sessions/compute` owns profile and
epoch policy. The runner adds compute guidance only when a Sandboxes connection was issued.
The integration also reads historical `sandboxes-native` and `sandboxes` files directly, checking
historical project ownership and recorded file identity without rewriting manifests or native rows.

## Historical adoption notes (superseded by the integration above)

Status: accepted by the owner on 2026-10-04. Phase 1 (the capability) and phase 2 (removing the
older path and the version changes below) are implemented. The following records that earlier change. It decided two things:

- **The older Merv-side compute path is retired.** That path is the `task.compute_*` and
  `compute.*` tools, the `ManagedCompute` and `WorkMachines` ledgers, and the legacy
  `SandboxComputeAdapter`.
- **Compute is a capability that Sandboxes attaches to a leased assignment of any workflow.** It is
  not something Tasks or Experiments own.

## Why

Compute is used across different units of work. Before this change its rules were written three
times: in Tasks, in Experiments, and twice in Sandboxes (once for the older path and once for the
native path):

- Tasks and Experiments each chose a profile (`in_review ? check : execute` and
  `running ? execute : check`) and an attempt epoch (the revision, and `attempt:state`).
- Both pinned, transitioned and revoked native work themselves.
- Both carried a copy of the older compute tools, ledgers and admission code, with their version
  numbers hard-coded.
- Sandboxes only knew the work kinds `task` and `experiment`.

## The rule

A worker gets compute only under all of the following conditions:

1. It is a **leased worker session** of a workflow instance. Access is scoped to that lease and
   expires with the session's hard deadline.
2. The project is **linked to a Sandboxes namespace and account**. Without a link, no connection
   is attached and the work runs without compute.
3. Its unit **opts into compute** through `computeKind` in the assignment's `references`. An
   assignment that declares none gets no compute. Work and attempt scope come from Merv's workflow
   instance and compute epoch.
4. Its **profile** is `execute` or `check`:
   - The assignment's `references` may name `computeProfile`: `execute`, `check` or `none`.
   - Otherwise the profile is `execute` when the fixed execution policy is writable
     (`readOnly: false`) with a `persistent` workspace, and `check` in every other case.
   - `check` instructs the worker to perform brief verification; this is Merv guidance.
   - Inquiry sessions and retained read-only checkouts receive no connection.

Applied to today's units, the default gives:

| Unit       | Assignment                                | Profile |
| ---------- | ----------------------------------------- | ------- |
| Task       | work                                      | execute |
| Task       | review                                    | check   |
| Experiment | running                                   | execute |
| Experiment | planned, design_review, experiment_review | check   |
| Reflection | lens, synthesis, review                   | check   |

Conflict-resolution service tasks declare `computeProfile: 'none'`.

Resources belong to the work item. They survive a worker handoff, and they are fenced when the
work's **compute epoch** changes:

- The epoch is the instance's workflow data field `computeEpoch` (a string) when the unit sets it,
  and otherwise its revision.
- Experiments set `computeEpoch` to `attempt:state`, so `retry_running` keeps the same machines and
  jobs.

## Versions

New tasks and experiments always use the native contracts (task@44 and experiment@42),
whether or not the project is connected. Their execution policies grant no compute tools, so they
need no new versions.

The older contracts (task@31/35 and experiment@28/32) were retired on 2026-10-05: production held
no instance of any of them. Their compute grants went with them, and the `experiments@6`
migration drops `experiment_compute_runs`, which held no rows.

## Removed

- The `task.compute_*` and `compute.*` tools, along with:
  - the compute methods and bindings in Tasks and Experiments;
  - `ExperimentCompute`;
  - the GPU-run cards on the Running page;
  - `WorkComputeAccess` in contracts.
- In Sandboxes: `ManagedCompute`, `WorkMachines`, `SandboxComputeAdapter` and its `ml`
  configuration, together with `rentalGuidance`.

The ledger tables (`managed_compute_runs` and `work_compute_machines`) are kept, untouched.
Dropping them is a separate migration that waits on a production check.

## Cutover preflight

Inventory retained providers and native captures with these read-only queries. The inventory does
not register readers, migrate data, or rewrite immutable manifests.

```sql
SELECT f->>'provider', count(*)
FROM artifacts a, jsonb_array_elements(a.file_refs_json) f
GROUP BY 1;

SELECT count(*) FROM sandbox_native_captures WHERE artifact_id IS NOT NULL;
```
