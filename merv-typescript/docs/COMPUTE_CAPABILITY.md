# Compute as an assignment capability

Status: accepted by the owner on 2026-10-04. Phase 1 (the capability) and phase 2 (removing the
older path and the version changes below) are implemented; the release waits on the production
reads under "Before release". This page is the source of truth for the change. It decides two things:

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
2. The project has a **funded native Sandboxes connection**. Without one, no connection is attached
   and the work runs without compute.
3. Its **profile** is `execute` or `check`:
   - The unit's assignment `references` may name `computeProfile`: `execute`, `check` or `none`.
   - Otherwise the profile is `execute` when the assignment's fixed execution policy is writable
     (`readOnly: false`) with a `persistent` workspace, and `check` in every other case.
   - `check` permits brief verification only (native jobs of at most 300 seconds on existing
     machines).

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

## Who does what

**Units** (Tasks, Experiments, Reflections and later ones) do only two things, neither of which
needs a Sandboxes binding at runtime:

- Optionally return `computeProfile` from an assignment rule's `references`, and set
  `computeEpoch` in transition data.
- Read compute guidance with a pure function from `@merv/sandboxes/compute-capability`, and the
  retained captures of an instance through `ctx.sandboxes.captures(projectId, instanceId, tx)`
  when Sandboxes is loaded.

**Sandboxes** owns everything else, keyed by workflow name and instance id:

- **Pin on first launch.** The work is pinned the first time a launch needs it, which binds the
  payer at first use.
- **Attach.** It issues and attaches the native MCP connection from its launch-connections provider.
- **Revoke.** It revokes the connection from its own `session.closed` consumer.
- **Fence and close.** Its own `workflow.transition` consumer updates the epoch, which cancels
  obsolete attempts, and closes the work when the event says it is `terminal`.
- **Evidence.** It registers captures as artifact collections.
- **Display.** It draws compute resources on the Running page for every unit.

The native service is still sent `work_kind` `task` or `experiment`: `experiment` for the
`experiment` workflow, and `task` for every other workflow. Before giving other units their own
kinds, check which values the native service accepts. Leases issued before this change carry the
earlier `sandboxConnectionId`/`sandboxProfile` references, and they are honoured until they end
(7 days at most).

## Phase 1: the capability (implemented)

The capability ships before the older path is removed. What it settled:

**Unit-facing API** (`@merv/sandboxes/compute-capability`, pure, no Cordis):

- `computeProfile(policy, override?)` returns `execute`, `check` or `none` by the rule above. An
  override that is not one of the three grants nothing (`none`).
- `computeEpoch(data, revision)` returns `data.computeEpoch` when it is a printable string of at
  most 256 characters, else `String(revision)`.
- `computeGuidance(profile)` returns the assignment overlay text (empty for `none`).
- On the service: `ctx.sandboxes.captures(projectId, instanceId, tx)` returns the capture
  collections Sandboxes verified for an instance, and `[]` where native compute is not
  configured. Phase 1 also kept `ctx.sandboxes.nativeWork.connected(projectId, tx?)` for the
  units' version selection; phase 2 removed it.

**Units:**

- Tasks return `computeProfile: 'none'` from the references of the conflict-resolution
  versions (task@6/11). Every other task assignment gets the default.
- Experiments write `computeEpoch` = `attempt:state` into the workflow data at start and on
  every transition.
- Neither unit pins, transitions, references or revokes native work any more.

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
  unconfirmed. Until it confirms, every other workflow is sent as `task`.
- A pinned work whose connection was revoked while the project later connected a different
  account is refused at launch, as before. It is not moved to the new account.

## Phase 2: the older path removed (implemented)

- **Versions.** Tasks and Experiments create every new work item on the native contracts and no
  longer ask Sandboxes whether the project is connected. The `task@31`/`35` and
  `experiment@28`/`32` execution policies are unchanged byte for byte (they are fingerprinted),
  so live work keeps its pinned grants; the tools those grants name are no longer registered.
- **Briefs.** Every non-service assignment, on any registered version, carries
  `computeGuidance(profile)`. The rental guidance, `GPU_WORK`, the planner's "Planning has no
  compute.run" guidance and the "Current work machines" line are gone.
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
- **Retained captures.** Capture collections the older path registered remain artifacts, but
  their member files name the `sandboxes` file provider, which is no longer registered: their
  manifests still read, and member downloads answer `download_unsupported`. The objects stay
  retained in Sandboxes storage, so a read-only provider could be restored if they are needed.

## Versions

New tasks and experiments always use the native contracts (task@39/43 and experiment@36/40),
whether or not the project is connected. Their execution policies grant no compute tools, so they
need no new versions.

The older contracts (task@31/35 and experiment@28/32) stay registered while live work uses them.
Their compute grants name tools that no longer exist and are inert. They are retired later
through the usual version-retirement process.

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

## Before release

Read production first:

- **Live runs and rentals on the older path.** These are bounded: a run or rental lasts at most
  1,380 minutes.
- **Projects without a funded native connection.** These lose GPU access.
- **Open leases on task@31/35 and experiment@28/32.**
