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

Do not activate the old native plugin alongside this integration: Sessions has one launch-provider
slot. Keep the old plugin disabled until its removal and the deployment switch.

## Historical adoption notes (superseded by the integration above)

Status: accepted by the owner on 2026-10-04. Phase 1 (the capability) and phase 2 (removing the
older path and the version changes below) are implemented; the release waits on the production
reads under "Before release". The following records that earlier change. It decided two things:

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

## Historical native lifecycle

**Sandboxes:**

- `sandbox_native_work.work_kind` now holds the workflow name. Migration `sandboxes-native@3`
  replaces the `task`/`experiment` CHECK with the workflow-name pattern and adds
  `epoch_revision`, the instance revision the epoch was last derived at. Existing rows take
  their instance's current revision, so in-flight work keeps its attempt until its instance
  next moves.
- The epoch only moves forward. The launch provider and the transition consumer both derive
  it from the instance as it stands, and only when `epoch_revision` is behind the instance's
  revision.
- Launch refuses a lease whose instance has moved past the lease's revision. In a project
  without a funded connection it attaches nothing and takes no writer lock.
- Consumers, both `from: 'beginning'` and safe to replay:
  - `sandboxes.native-leases.v1` (`session.closed`) tombstones the lease and queues revocation
    of its assignment. History older than eight days adds no tombstone unless an assignment
    exists.
  - `sandboxes.native-work.v1` (`workflow.transition`) touches only work already pinned. It
    advances the epoch. It closes the work when the event is `terminal` and its revision is the
    instance's current revision, or when the instance no longer exists.
- Capture file references accept any workflow name as their kind.

**Not yet done:**

- Which `work_kind` values beyond `task` and `experiment` the native service accepts is
  unconfirmed. Until it confirms, units declare one of those two.
- A pinned work whose connection was revoked while the project later connected a different
  account is refused at launch, as before. It is not moved to the new account.

## Phase 2: the older path removed (implemented)

- **Versions.** Tasks and Experiments create every new work item on the native contracts and no
  longer ask Sandboxes whether the project is connected. The `task@31`/`35` and
  `experiment@28`/`32` execution policies are unchanged byte for byte (they are fingerprinted),
  so live work keeps its pinned grants; the tools those grants name are no longer registered.
- **Briefs.** The runner adds `computeGuidance(profile)` after a connection is issued. The rental
  guidance, `GPU_WORK`, the planner's "Planning has no compute.run" guidance and the "Current work
  machines" line are gone.
- **Reads.** `task.get` and `experiment.get_state` no longer return `compute` or `machines`;
  `captureArtifactIds` holds only the captures Sandboxes verified. The Running page no longer
  draws GPU-run cards or the experiment sidebar's GPU runs table.
- **Ledgers.** `managed_compute_runs` and `work_compute_machines` stay. Their published
  migrations (`sandboxes-compute@1-2`, `sandboxes-work-machines@1`) are still registered,
  unchanged, from `packages/sandboxes/src/compute-ledgers.ts`, which native Sandboxes runs at
  startup; nothing reads or writes the tables. The startup copy of `experiment_compute_runs`
  into `managed_compute_runs` is gone (production already holds its rows).
- **Configuration.** The `ml` adapter configuration is gone from Sandboxes and from the
  renderer, with `MERV_SANDBOXES_ML_SINCE` and `MERV_SANDBOXES_ML_STORAGE_ORIGIN`.
  `MERV_SANDBOXES_ML_NAMESPACE` and `MERV_SANDBOXES_ML_TOKEN` remain: Merv-managed native ML
  (`native.managed`) uses them, and the renderer now reads them only when
  `MERV_SANDBOXES_MANAGED_ML_ENABLED` is set.
- **Retained captures.** Capture collections the older path registered remain artifacts whose
  member files name the `sandboxes` file provider. A read-only provider (`legacy-captures.ts`)
  keeps them downloadable under the same ML grant when the deployment sets
  `MERV_SANDBOXES_ML_STORAGE_ORIGIN` (rendered as `legacyCaptures`). Without it, their manifests
  still read and member downloads answer `download_unsupported`.

## Versions

New tasks and experiments always use the native contracts (task@43 and experiment@41),
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

## Before release

Read production first:

- **Live runs and rentals on the older path.** These are bounded: a run or rental lasts at most
  1,380 minutes.
- **Projects without a funded native connection.** These lose GPU access.
- **Open leases on task@31/35 and experiment@28/32.**
