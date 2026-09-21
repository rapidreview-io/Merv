# The Git model

Status: design, not yet implemented. This document fixes how Merv uses Git once work units branch from one another, are merged automatically, and reach `main` only through consolidation. It extends [Runner Git workspaces](WORKSPACES.md), [Code operations](CODE_OPERATIONS.md), [Work-item dependencies](WORK_ITEM_DEPENDENCIES.md), [Consolidation](CONSOLIDATION.md) and [GitHub publication readiness](GITHUB_PUBLICATION_READINESS.md). Where it names a file and line, the fact was read in the tree this design was cut from.

The ten numbered decisions in the next section are the owner's and are not reopened here. Everything after them is the design that carries them out, revised after two independent challenges. The section "What the challenges changed" lists what was adopted and what was refused.

## What each Git object means in Merv

| Git object    | Meaning in Merv                                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit        | An immutable state of a unit's code. Merv never trusts a commit because it exists. A commit matters only when a record names it: a `code.commit` receipt, a session capture, a unit's accepted commit, or a base record's result.                  |
| Branch        | The name of one unit's line of work. Every unit with a Git workspace has exactly one. A branch is where work is pushed so another machine can resume or review it. It carries no authority: "done" is a server record that names one commit on it. |
| `main`        | Consolidated, reviewed research. It is the connected repository's base branch. It moves only when a human operator merges the pull request of a reviewed consolidation. No agent, session or runner can move it.                                   |
| Worktree      | A runner's private checkout for one assignment. It is disposable. Nothing is true because it is in a worktree; it becomes a fact when the runner commits or captures it and the server stores the receipt.                                         |
| Remote        | The project's connected GitHub repository. It is transport and shared storage between machines, and the place where `main` lives. It is not a source of truth about work state; the server's records are.                                          |
| Merge commit  | Always two parents. Made either by a runner job from a base record (machine-made, deterministic) or by `code.merge` inside a merge task or a consolidation (agent-resolved, reviewed).                                                             |
| Ref namespace | `merv/work/**`, `merv/base/**`, `merv/accepted/**`, `merv/proposals/**` and `main` are kept apart so each has one writer and one update rule.                                                                                                      |

The server never inspects Git objects (docs/WORKSPACES.md). Every Git fact it holds is an authenticated runner observation, or a read of the GitHub API made by the server itself.

## The ten decisions

1. Every unit of work with a Git workspace (task, experiment, consolidation, merge task) gets one branch named after it. `main` is consolidated, reviewed research and moves only at consolidation. No agent or runner can move `main`.
2. A unit that depends on other units branches from its dependency's accepted commit, which is pinned and immutable. The base is derived from the dependencies. Units without code in a dependency chain are skipped.
3. A unit that depends on more than one code-bearing unit starts from an automatic merge of their accepted commits. If the merge does not work, the server creates a merge task, an ordinary reviewed task, which becomes a dependency of the unit that was about to start. The unit continues from the merge task's accepted commit. The same holds for experiments.
4. No duplicate merges. There is one base record per distinct set of accepted commits in a project, keyed by a hash of the sorted commit ids, unique per (project, key). The merge attempt is a Code command claimed by exactly one runner. The merge task's requestId is derived from the key. It is attached to every unit waiting on that key, present and future. Bases are resolved proactively when a dependency is accepted; the dispatch-time check is the fallback.
5. Overlapping sets are reused from the first version. Every merge has two parents. The record for a set is built from the largest existing record inside it, then the record that adds the most of what is missing, then single commits. Every intermediate union has its own record. Records are never invalidated, because accepted commits are immutable.
6. A clean automatic merge is not proof that the code works. A project may configure a check command. The runner runs it once per base record after the merge. A failing check is treated as a conflict. Every base is recorded as `single`, `auto` or `task`.
7. The runner pushes the unit's branch to the shared remote at every session end. Runners fetch what they need when preparing a workspace. The shared remote is the connected GitHub repository. Namespaces keep work branches, base branches and `main` apart, and GitHub protection keeps runners off `main`.
8. Large files never enter Git. Big outputs go to artifacts and blobs with pointers.
9. Consolidation merges the leaf branches. Retain, adapt and drop are reconciled with ancestry: work that retained work was built on cannot be dropped, only adapted. The reviewed consolidation result is what moves `main`.
10. Tasks, Experiments and Research declare only that a unit has a Git workspace and carry an opaque code reference. The Code plugin owns everything Git-shaped. With Code unloaded everything keeps working, without workspaces.

## Vocabulary and naming

**Unit.** A workflow instance whose version declares a Git workspace: a task, a merge task, an experiment or a consolidation. It is identified by (workflow, instance id) and registered once in Code.

**Work branch.** One per unit: `merv/work/<workflow>/<instanceId>` on the remote. Instance ids are already safe as ref components; Code applies the runner's `refSegment` encoding (packages/runner/src/workspaces.ts:104-110) to anything else. The runner's private local branch name (`codex/merv/shared/<namespace>/<project>/<instance>`, workspaces.ts:275) does not change. It is an implementation detail of one ledger; the remote name is the model's name.

**Accepted commit.** The commit the passing independent review was attached at. For a task it is the delivered head that `checkoutReviewer` compared with the reviewer's attachment (packages/tasks/src/index.ts:900-928). For an experiment it is the capture of the approved results submission. For a consolidation it is the head of the sealed proposal. It is written once, in the review-pass transaction, and never changes, because success states are terminal. The work branch may hold later captures; that is harmless.

**Accepted ref.** `merv/accepted/<workflow>/<instanceId>`, created by the server at acceptance and never updated. It keeps the accepted commit reachable on GitHub whatever happens to the work branch.

**Code reference (`CodeRef`).** `{ branch, commit }`. The only Git-shaped value an owning plugin stores. The owner cannot interpret it. It is returned by `code.accept` and kept in workflow data under `data.codeRef`, where Code reads it back through `Workflows.get`, so Code never injects Tasks or Experiments. A base record's result is never a `CodeRef` and is never called accepted.

**Code frontier.** The set of accepted commits a unit must start from. Walk the unit's workflow dependencies. A code-bearing dependency contributes its accepted commit and the walk stops there. A dependency without code is skipped and the walk continues through its own dependencies. Merge tasks are excluded (they are found through `code_units.merge_key`). Then every commit that Code's lineage already knows to be an ancestor of another member is removed. The result is the set S.

- S empty: the base is `main`, pinned from Code's cached head of `main`.
- S has one member: that commit. No record is needed. The kind is `single`.
- S has two or more members: the base record with key(S).

**Lineage.** What Code knows about ancestry without reading Git: a unit's pinned base, the members and inputs of a base record, and so on transitively. It covers only bases Merv made. Ancestry created by hand or by legacy versions is unknown, which costs at most one pointless job that ends as `fast_forward`.

**Base key.** `key(S) = sha256hex("merv-base/1\n" + sorted lowercase commit ids joined by "\n")`. The key names the set and nothing else.

**Base record.** One row per (project, key). It remembers how the set was reconciled: its two inputs (each a commit or another record), its state, how it was made (`auto` or `task`), the result commit, the conflict or check details, the merge task, and the attempt number. `single` is a kind of resolution, never a row.

**Base branch.** `merv/base/<key>`. Created once, after the server has accepted a result for the key, and never updated.

**Merge task.** An ordinary reviewed task of type `task.merge` on a task version that grants `code.merge`. It starts from the record's left input and receives the right input as the frozen reference `mergeWith`. It has its own work branch like every unit.

**Remote namespaces.**

| Namespace                                 | Writer                                                         | Rule                           |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------ |
| `merv/work/**`                            | runners                                                        | fast-forward only, no deletion |
| `merv/base/**`                            | runners (auto) and server (task)                               | create only                    |
| `merv/accepted/**`                        | server                                                         | create only                    |
| `merv/proposals/**`                       | server                                                         | create only (existing)         |
| `merv/checkpoints/**`, `merv/captures/**` | runners, legacy versions only                                  | create only (existing)         |
| `main` (`binding.baseBranch`)             | GitHub, on an operator's merge of a consolidation pull request | pull request required          |

`central` on a runner becomes no more than its cached view of `main`. New versions never use it as a base; they always receive an explicit pinned `reference:base`.

## Plugin boundaries

| Plugin                            | What it sees                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks, Experiments, Consolidation | "This unit has a Git workspace", an opaque `CodeRef`, opaque reference values to pass through, a base status to show, and ids of tasks that Code asks them to attach. Never a branch name, a key, a remote or a merge. |
| Research                          | Nothing new. `materialise` keeps calling `tasks.create` and `experiments.create`.                                                                                                                                      |
| Workflows                         | Dependencies and frozen references, as today. No Git knowledge.                                                                                                                                                        |
| Sessions                          | The frozen attachment and the one final result, as today, plus a small check Code can call: "is this caller a registered, live runner".                                                                                |
| Code                              | Branch naming, the frontier, base records, the planner, the merge job, `code.merge`, push and fetch grants, receipts, the check command, the cached head of `main`, lineage, consolidation decisions as lineage facts. |
| Runner                            | Executes fixed operations it is handed: commit, merge into a worktree, base merge, check, push, fetch. It never chooses a branch name or a target.                                                                     |
| Scope                             | One service actor per project for server-made work (see "Authority").                                                                                                                                                  |

An owner's whole contact with Code is five calls, all reached through `ctx.code` inside the owner's Code child injection, so none of it exists when Code is unloaded:

- `code.declare(caller, { unitId, workflow }, tx)` at creation, and again after the unit's dependencies change before it has a base. Returns the resolution and the ids of merge tasks to attach now.
- `code.baseStatus(caller, unitId, tx)` — strictly read-only. Called from the owner's `lease.role` hook and from its evaluation.
- `code.workspaceReferences(caller, { unitId, purpose }, tx)` from the owner's `references()` callback.
- `code.accept(caller, { unitId, capture }, tx)` in the review-pass transaction. Returns the `CodeRef`.
- `code.unitClosed(caller, { unitId }, tx)` in the transaction that ends a declared unit without success.

Each owner also registers one callback, `code.owner(workflow, { dependencies })`, through which Code asks the owner to attach or detach a task id on a list of its own units, using the owner's own workflow handle (only the owning program handle may call `addDependencies`, packages/workflows/src/index.ts:427-430). Tasks additionally mounts one consumer that creates merge tasks.

## Data model

All server tables live in `packages/code/src` with `*.postgres.ts` twins: TEXT and INTEGER columns only, JSON as canonical TEXT, the same immutability and transition triggers written as plpgsql functions, as `commands.postgres.ts` already does. Every table is an additive migration.

Both backends serialise writers. SQLite uses `BEGIN IMMEDIATE`; Postgres takes a per-schema `pg_advisory_xact_lock` at the start of every write transaction (packages/state/src/postgres.ts:227-232). The design relies on this for the same reason the rest of Merv does, and still makes every insert idempotent on its unique key so that nothing depends on the order in which transactions are admitted.

### `code_units` (PK `project_id, unit_id`)

`workflow`, `branch`, `target_key` (the key the unit currently waits on; may change until the base is pinned), `base_kind` (`main | single | record | merge`), `base_key`, `base_oid`, `base_pinned_at`, `merge_key` and `merge_attempt` (set only for merge tasks), `head_oid` (last captured head), `head_runner_id`, `pushed_oid` (last head the server verified on the remote), `push_state` (`ok | rejected | quarantined`), `accepted_oid`, `accepted_at`, `accepted_ref_at`, `created_at`.

Triggers: identity columns immutable; `base_*` write-once; `accepted_oid` write-once; no delete. Indexes on `(project_id, accepted_oid)` and `(project_id, target_key)`.

A unit moves declared → based (base pinned at the first successful work lease) → accepted. `head_oid` and `pushed_oid` move freely before acceptance.

Waiters are not a table. The units waiting on a key are the not-yet-based units whose `target_key` is that key or a record that has that key among its inputs, transitively. This is a query over `code_units` and `code_bases`.

### `code_bases` (PK `project_id, key`)

`size`, `members_json` (sorted), `left_kind`, `left_ref`, `right_kind`, `right_ref` (kind is `commit` or `base`), `state` (`attempting | merged | conflict | resolving | blocked`), `how` (`auto | task`), `result_oid`, `tree_oid`, `outcome_json` (conflicted paths capped at 200 with a truncated flag, or the check's hash, exit code, duration and the last 16 KiB of output), `check_hash` (NULL when no check was configured), `merge_task_id`, `attempt`, `published_at` (the base branch was verified on the remote), `recheck_json` (the independent recomputation, see "The auto-merged base and review"), `created_at`, `updated_at`.

Allowed transitions: attempting → merged | conflict | blocked; conflict → resolving | blocked; resolving → merged | conflict | blocked; blocked → conflict (operator retry). `merged` is terminal; `result_oid`, `tree_oid` and `how` are immutable once set. `CHECK (state = 'merged') = (result_oid IS NOT NULL AND how IS NOT NULL)`. Key, size, members and inputs are immutable. No delete. Indexes on `(project_id, left_kind, left_ref)`, `(project_id, right_kind, right_ref)` and `(project_id, state)`.

There is no `waiting` state. A record whose inputs are not both resolved is `attempting` with no command yet; the phase shown to people is derived.

### `code_base_members` (PK `project_id, key, oid`)

Insert-only, indexed on `(project_id, oid)`. The planner's subset query selects keys whose member count inside S equals the record's `size`.

### `code_base_commands` (PK `id`)

The journal of session-less runner jobs. `project_id`, `key`, `attempt`, `command_json` (immutable: kind `base.merge`, key, left and right commits, date rule version, check `{command, hash, timeoutSeconds}` or null, repository id, binding revision), `status` (`queued | claimed | succeeded | failed | cancelled`), `runner_id`, `claims` (the fencing token), `claim_expires_at`, `receipt_json`, `error`, `created_at`. `UNIQUE (project_id, key, attempt)` and a partial unique index allowing one non-terminal command per (project, key). Same trigger style as `code_commands`, plus claimed → queued for release and expiry. `code_commands` itself is unchanged: its rows stay bound to a session (packages/code/src/commands.ts:114-148), and the new session-bound `code.merge` rides in `command_json` with kind `merge`.

### `code_main_heads` (PK `project_id, repository_id`)

`oid`, `source` (`github | runner`), `observed_at`, `revision`. The one cache in the model. It exists so a base can be pinned inside the lease transaction without a network call.

### `code_unit_decisions` (PK `project_id, unit_id, consolidation_id`)

`decision` (`retain | adapt | drop`), `decided_at`. Insert-only, written when a consolidation completes. It makes an earlier drop or adapt visible to later consolidations.

### `code_settings` (PK `project_id`)

`revision`, `check_command` (one line, at most 2,000 characters), `check_timeout_seconds` (default 1200), `max_merge_attempts` (default 3), `updated_by`, `updated_at`, with a request table for requestId idempotency. `project-context` has no settings slot (packages/scope/src/project-context.ts:54-80), so this lives in Code.

### Pushes

`code_github_pushes` is reused as it is. New rows have ids `work:<commandId>`, `work:<sessionId>` and `base:<commandId>`, and an immutable `target_json` of `{ branch, headOid, treeOid }`. The expected old value of the remote ref is not part of the row; it is computed when the grant is issued.

### Runner ledger (SQLite only)

`runner_base_jobs` (command id, command, outcome, state) with an immutability trigger like `runner_code_commits`, and one new column `runner_checkout_slots.pending_merge_oid`. There is no push outbox.

### Contracts

```ts
type CodeRef = { branch: string; commit: string };
type CodeBaseInput = { kind: 'commit'; oid: string } | { kind: 'base'; key: string };
type CodeBaseState = 'attempting' | 'merged' | 'conflict' | 'resolving' | 'blocked';
type CodeBaseBlocker =
  | 'code_base_unresolved' // frontier complete, record not created yet
  | 'code_base_attempting'
  | 'code_base_resolving' // carries the merge task's own gate as detail
  | 'code_base_blocked'
  | 'code_base_unpublished'
  | 'code_base_disputed'
  | 'code_main_unknown'
  | 'code_head_unpublished'
  | 'code_push_rejected'
  | 'code_remote_unavailable';
type CodeBaseResolution =
  | { kind: 'none' }
  | { kind: 'main' | 'single'; commit: string }
  | { kind: 'merged'; commit: string; how: 'auto' | 'task'; inputs: [string, string] }
  | { kind: 'pending'; blocker: CodeBaseBlocker; detail?: string; mergeTaskIds: string[] };
```

Owners receive `CodeBaseResolution` without keys. The key appears only in Code's own tools and pages.

## The base-record lattice

### Resolve

`code.declare` upserts the unit and calls `resolve(unit)`.

1. If the base is pinned, return it.
2. Compute the frontier S. If a code-bearing dependency on the frontier is not yet accepted, return `pending` and create nothing. Nothing speculative is merged.
3. S empty → `main` from `code_main_heads`; empty cache → `pending: code_main_unknown`.
4. S of one → `single`.
5. Otherwise `ensure(S)`, set the unit's `target_key`, and return `merged` or `pending` together with the merge task id of every `resolving` record reachable through the inputs of key(S). The owner attaches those tasks in the same transaction. This is how a future waiter gets an existing merge task.

### Plan

`ensure(S)` is a pure function of S and the live records, tested on its own.

- If the row for key(S) exists, return it.
- C is every record whose members are a proper subset of S, in any state. Blocked records stay in C: a superset waits behind a blocked record and shows `code_base_blocked`; it does not route around a known conflict and ask a human for the same resolution twice. In-flight records stay in C for the same reason (see the open questions: this widens the owner's word "merged").
- `acc` is the record in C with the most members. Ties go to a merged record, then to the lower key. If C is empty, `acc` is the lowest commit id in S.
- While `acc` does not cover S: `next` is the record in C that adds the most uncovered members, with a gain of at least one, under the same tie rule. If there is none, `next` is the lowest uncovered commit id. `U = members(acc) ∪ members(next)`. `acc = insertOrGet(U, left = acc, right = next)`.
- Each insert is `INSERT .. ON CONFLICT (project_id, key) DO NOTHING` followed by a read. If another resolver built U from different inputs, its row is used and the fold continues from it. Safety comes from the unique key, not from both resolvers choosing the same plan; plan determinism only keeps waste low.
- A new row is `attempting`. Its command is inserted with it when both inputs are already commits; otherwise it has no command yet.

The merge commit's parents are (left, right) exactly as stored, so the intended commit is a function of the row. Overlapping inputs such as {A,B} and {B,C} are merged directly; Git sees B as common history.

**Promotion.** "A row in `attempting` with no command whose two inputs are now merged and published gets its command." This rule runs in three places: in the completion of any record, inside `ensure` whenever it meets such a row, and in `reconcile`. It is idempotent because the command is unique per (project, key, attempt).

**Proactive resolution.** `code.accept` emits `code.unit_accepted`. Code's consumer `code.units.v1` lists the unit's dependents, walks through dependents without code to reach code-bearing ones, and resolves each not-yet-based unit in ascending (|S|, key) order, so smaller sets exist before their supersets plan. Units with the same set meet the same key, so grouping is structural. `declare` also resolves, which covers units created after their dependencies were accepted, for which no acceptance event will ever come.

**Fallback.** `reconcile(project)` runs when Code loads and every 60 seconds: units that are declared, not based, with a complete frontier and no record; promotion; queued or expired commands; base and accepted refs not yet created; merge-task edges missing from a waiter; the head of `main`. All of it finds or creates rows keyed by set, so it is idempotent.

### The `base.merge` job

The job is claimed through Code's runner routes (see "Authority"). It runs in the runner's bare repository; no worktree is needed for the merge.

1. Fetch left and right by commit id with a job-scoped read grant. A transport failure releases the job. A conflict is never inferred from a transport failure.
2. If one input is an ancestor of the other, the outcome is `fast_forward` and the result is the descendant. No commit is made.
3. `git merge-tree --write-tree <left> <right>` under the runner's fixed environment. Exit 1 → outcome `conflict` with the conflicted paths. A runner with Git older than 2.38 does not advertise the `baseMerge` capability and is never offered a job (the development machine has 2.39.3).
4. Attributes are pinned. An agent can commit `* merge=union` to a work branch, and whether a bare `merge-tree` reads in-tree attributes depends on the Git version: on 2.39.3 it does not (tried: two sides that both edit one line under `* merge=union` still conflict), and newer versions can. The job therefore runs with an empty attribute source where Git supports one and refuses to run where it cannot guarantee that in-tree merge attributes are ignored. A runner fixture with `merge=union` asserts that the outcome is `conflict`. Custom merge drivers, hooks and the global attributes file are already off (workspaces.ts:1424-1469).
5. `commit-tree -p left -p right` with the identity `Merv Agent Runner <merv@localhost>`, author and committer date `max(committer date of left, of right)` written as `<epoch> +0000`, and the message `merv: base <key>`.
6. `checkTreeFiles` on the result tree applies the 50 MiB refusal to the merged tree.
7. If the command carries a check: a detached, ephemeral worktree at the result, the frozen command string run through `/bin/sh` inside the same sandbox profile as a worker launch, with no Merv credential, no GitHub token, the launch network policy and the frozen timeout. The worktree is removed afterwards.
8. `complete(receipt)` to the server. **Nothing has been pushed yet.**

**The server decides first.** The first receipt accepted under a valid claim is the only authority for a key. `complete` requires the same runner, an unexpired claim and the command's current `claims` value as a fencing token. A later completion with an identical outcome and result is answered with the stored result; a different one is refused with `code_receipt_conflict`. The claim lasts as long as the fetch, merge, check and push timeouts together plus a margin, and the runner renews it while it works, so a long check cannot outlive its claim and be run twice.

Outcomes:

| Receipt                                                             | Record                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `merged`, `fast_forward`                                            | `merged`, `how = auto`, result stored. `published_at` is still NULL.                   |
| `conflict`, `check_failed`                                          | `conflict`. Nothing is ever pushed for these.                                          |
| `check_error` (timeout, sandbox launch failure, killed by a signal) | The job is released for one more claim. A second `check_error` becomes `check_failed`. |

**Then the push.** For a merged record the runner asks for a push grant for `merv/base/<key>` at exactly the recorded `result_oid`, pushes create-only (the existing `--force-with-lease=<ref>:` path, workspaces.ts:1125-1176; an existing ref with the same commit is success), and the server verifies the ref and tree on GitHub and sets `published_at`. If that runner is gone, `reconcile` hands the push to another runner that holds the objects, or the job is repeated and its receipt compared. Units are gated by `code_base_unpublished` until then. Because only one result can exist for a key before anything is pushed, the base branch can never hold a commit the server did not accept, even when two runners' merges are not byte-identical. Cross-runner equality of the merge commit is an optimisation that makes repeats harmless, not an invariant.

Jobs that carry a check are never offered to a runner without a sandbox profile.

### Conflict → one merge task → every waiter

On a `conflict` or `check_failed` completion Code decides, in that transaction, what comes next. If the attempt number exceeds `max_merge_attempts` the record becomes `blocked` and Code emits `code.base_blocked`. Otherwise it emits `code.merge_task_needed { ref, attempt, sides, conflict | check, checkCommand, excludedActorIds }`. `ref` is an opaque string; the owner never parses it. `sides` carries, for each input, the branch, the commit, and the title and goal of the unit or units behind it, which Code reads through `Workflows.get`.

Tasks mounts the consumer `tasks.code-merge.v1` inside its Code child injection. For each event it:

1. Builds the merge brief artifact: the two sides and what each was for, the conflicted files or the tail of the check output, the check command, and the procedure ("call `code.merge` with the `mergeWith` commit, resolve, `code.commit`, deliver"). The review criteria include "the intent of both sides survives".
2. Calls the trusted hook `tasks.createForCode(tx, serviceCaller, { type: 'task.merge', workspace: 'git', requestId: 'code-base:<ref>:<attempt>', brief, excludedActorIds })`. It goes through the same create path as `task.create`, so it is idempotent through `task_commands` exactly as `materialise`'s derived requestIds are (packages/research/src/index.ts:1411-1413). A replayed event returns the same task.
3. Calls `code.assignMergeTask(ref, attempt, taskId, tx)`. Code moves the record conflict → resolving by compare-and-set, declares the task's unit with `base_kind = merge` (base is the left commit, `mergeWith` the right), and, still in this transaction, calls each registered owner callback with the list of that owner's waiting units and the task id. Each owner attaches the task through its own handle with requestId `code-base:<ref>:<attempt>:<unitId>`.

Creating the task, moving the record and attaching every present waiter are one transaction. Future waiters receive the task id from `declare`. `reconcile` repairs any edge that is missing.

**The edge is visibility; the gate is Code's.** A waiter does not start because its owner's `lease.role` hook asks `code.baseStatus` and refuses while the base is not ready. The dependency edge exists so that the graph, the evaluation and people show the truth ("this experiment waits for that merge task"), as decision 3 requires. A waiter that briefly lacks the edge is still correctly held.

**Accepting the merge task.** The Tasks review-pass transaction calls `code.accept`. For a unit with a `merge_key`, Code requires that the delivered commit contains both inputs. Containment is a runner observation (`merge-base --is-ancestor`) reported in two receipts from two attachments: the producer's commit receipt and the reviewer's attach receipt. If either lacks an input the pass is refused with `code_merge_incomplete`; the same check runs earlier at delivery. Code then sets the record `merged`, `how = task`, result = the accepted commit, schedules the create-only `merv/base/<key>` ref through the server's `ensureBranch` (packages/code/src/github-client.ts:225-248), and runs promotion.

**A merge task that fails or is abandoned.** Tasks calls `code.unitClosed` in the transaction that ends the task. In that same transaction Code moves the record resolving → conflict with attempt + 1 (or → blocked at the limit), and asks each owner, through its callback, to detach the failed task from all its waiters. No committed state ever contains a failed merge-task edge on a waiter. This matters: Workflows turns a failed dependency into the suggested next action `mark_failed` (packages/workflows/src/evaluation.ts:489-503; tasks and experiments both set `dependencyFailureAction: 'mark_failed'`), and a person or agent following that suggestion would fail the waiting experiments and, through them, research cycles. After the detach the waiter's only gate is the Code blocker. The new `code.merge_task_needed` event then produces the next attempt's task, with a new requestId suffix, which is attached to every waiter.

**A merge task that stalls.** A task that exhausts its review rounds stays non-terminal and escalated. `code.baseStatus` for a `resolving` record includes the merge task's current gate, so each waiter shows `code_base_resolving` with the detail "merge task escalated: loop_limit_reached". No automatic transition is needed; granting more rounds or a human `mark_failed` moves it.

**Blocked.** After the last attempt the record is `blocked`. Waiters show `code_base_blocked`. A human project admin may call `code.base_retry`, which returns it to `conflict` and issues a new attempt.

### The auto-merged base and review

A merged base with `how = auto` is one runner's word, and no review looks at it by default: a unit's review diff is computed base..head, so the merge commit's own content is outside it. Two measures close this.

- The base's kind and its two inputs are frozen into the unit's work and review references and context: "base: automatic merge of X and Y, machine-made, not reviewed". The review recipes of the new task, experiment and consolidation versions say that the review covers the base.
- The reviewer's runner recomputes `merge-tree(left, right)` when it attaches and reports the tree id in its attach receipt. The first such report from a runner other than the one that made the base is stored in `recheck_json`. If the trees differ, review pass for units on that base is refused with `code_base_disputed` until a human project admin records an acknowledgement after inspecting the merge. The record itself never changes. In a project with one runner the recheck is stored as not independent and does not block.

### Worked examples

**Two tasks, three experiments.** T1 and T2 are done with accepted commits `a` and `b`. E1, E2 and E3 each depend on both. When the second task is accepted, `code.units.v1` finds the three dependents; each has frontier {a,b} and the key K. The first resolve inserts row K (left = the lower of `a` and `b`) and its command; the other two find the row. One runner claims the job, merges, reports `merged`, pushes `merv/base/K`. All three experiments pin the same base at their first lease. One record, one job, no task.

**{A,B}, then {A,B,C}.** K_AB is merged (by job or by task). A unit arrives with frontier {a,b,c}. C contains K_AB; `acc = K_AB`, `next = c`, and the new row K_ABC has left = `{base: K_AB}` and right = `{commit: c}`. The job merges `c` into the reconciled A+B. If K_AB is still `resolving`, K_ABC is inserted with no command, the unit receives K_AB's merge task as a dependency, and promotion starts K_ABC's job when K_AB merges. If K_ABC then conflicts as well, the unit receives a second merge task, for K_ABC.

**{A,B} + {B,C}.** Both records are merged. For S = {a,b,c}, `acc` is the lower key of the two (equal size), `next` is the other, gain one. The job merges the two results directly. Git finds `b` on both sides and treats it as common history.

**Conflict.** In the first example the job reports `conflict` on `src/model.py`. Code emits `code.merge_task_needed` for attempt 1. The consumer creates M (requestId `code-base:<ref>:1`), Code marks K `resolving`, and Experiments attaches M to E1, E2 and E3 in the same transaction. E4, created an hour later with the same dependencies, receives M from `declare` and attaches it at creation. M is worked, reviewed and accepted at `m`. K becomes `merged`, `how = task`, result `m`. All four experiments start from `m`. Any later superset of {a,b} builds on `m`.

**Merge task failed or abandoned.** M is marked failed. In that transaction K returns to `conflict` with attempt 2 and M is detached from E1–E4. Their gate is `code_base_resolving` (then the new task), never `dependency_failed`, and `mark_failed` is not suggested. M2 (requestId `code-base:<ref>:2`) is created and attached. After three failed attempts K is `blocked`, no merge task is attached, the four experiments show `code_base_blocked`, and an admin decides.

### Invariants

Each is a test.

- I1 Uniqueness: one record per (project, key); one non-terminal command per key; one merge task per (key, attempt).
- I2 The planner is a pure function of (S, records).
- I3 N concurrent resolves that share S, or share an intermediate, yield one row, one command, one merge task, and the task is a dependency of all N.
- I4 Reuse: after {A,B} is merged by a task, the record for {A,B,C} has left = {base: key(A,B)}.
- I5 Termination: fold depth ≤ |S| − 1; attempts ≤ the limit; every record reaches `merged` or `blocked`.
- I6 Immutability: a merged record never changes; new accepted commits only create new keys.
- I7 Single result: a key has at most one accepted result, and `merv/base/<key>` is only ever created at it.
- I8 Chains: git → none → git bases the last on the first's accepted commit; T3 → {T1, T2} with T2 → T1 collapses to single(T2).
- I9 Code unloaded: no consumer runs, Git create and lease answer `code_unavailable`, scratch units are unaffected, cursors resume on reload.
- I10 A transport failure never produces a conflict.
- I11 No committed state has a failed merge task as a dependency of a waiter.
- I12 A pending base makes a unit ineligible at `lease.role`; it never records a launch failure or a dispatch hold.

## Where a pending base surfaces

This is the point the first draft had wrong. `dispatchCandidates` only calls `leaseRole` (packages/workflows/src/index.ts:575); the `references()` callback runs later, in `execution()` at session-offer time (index.ts:1061). A 4xx raised there becomes a `PoisonedOffer` (packages/sessions/src/dispatch.ts:1421-1427), is counted as a launch failure, and after `maxLaunchFailures` the target is held until an operator releases it. None of the base blockers is in `uncountedOfferCodes` (dispatch.ts:141-152). So a refusal from `references()` would page an operator for every healthy unit with several dependencies.

The rule is therefore:

- The owner's `lease.role` hook calls the read-only `code.baseStatus` and throws the blocker as a 409. Tasks already calls `requireCode()` in that hook (packages/tasks/src/index.ts:427). `dispatchCandidates` treats a 409 as ineligible, which is the correct reading of "the base is not ready".
- The check is made for the first leasable state of a Git unit, not only the state with the workspace. An experiment is gated in `planned`, so a conflict surfaces before a design session exists, and attaching a merge task never bumps the revision under a live session.
- The same status is lifted into the owner's evaluation blockers, ahead of the dependency gate, so the unit shows as blocked with a named code and cause.
- `references()` keeps its refusal as the last line, and the `code_*` blockers are added to `uncountedOfferCodes`.
- `workspaceReferences` pins the base on the first successful work build. It is the only write on this path, a write-once compare-and-set that commits with the lease.

## Push and fetch

**Push.** For a declared unit the runner pushes `merv/work/<workflow>/<instance>` after every `code.commit` and `code.merge` and at every session end. The server computes the target and freezes `{ branch, headOid, treeOid }` in a push row; when it issues the grant it supplies the expected old value (the unit's `pushed_oid`, empty for the first push). The runner first checks `merge-base --is-ancestor <expected> <head>` and refuses to push otherwise, then pushes with `--force-with-lease=<ref>:<expected>`. The server re-reads the branch and tree from GitHub (`transport.verify`) and advances `pushed_oid`. A commit command still completes only after its push is verified, as `requireCheckpoint` requires today.

A push counts as done when the remote ref equals the target, or when the server already holds a later verified head that descends from it; the older push row is then marked superseded. This covers a capture push that failed and was overtaken by the next session's push.

**Failure at capture.** The session still closes and its capture is recorded; `head_oid` is ahead of `pushed_oid`. The runner retries on its normal loop and at the next session end. There is no outbox table. The runner classifies the result from `push --porcelain` and the remote status:

- transport error → retry with backoff; the unit shows `code_head_unpublished`;
- rejection by GitHub (push protection found a secret, a ruleset, a size limit) → terminal; the unit gets `push_state = rejected` and the blocker `code_push_rejected`, lifted into evaluation. A capture only appends commits, so retrying cannot help.

While a binding exists, both work leases and review leases of a unit are gated on `head_oid = pushed_oid`. Otherwise the next session could land on another machine with a `resume` commit that GitHub does not have, and fail with `workspace_base_missing` on every dispatch. Two admin-only tools (human, not a session, not a key) resolve the terminal cases: `code.unit_discard_head` when the runner holding an unpushed head is gone for good (the unit resumes from `pushed_oid`), and `code.unit_quarantine`, which deletes the remote work branch of a unit whose history must not stay, and marks the unit.

**Acceptance.** `code.accept` requires the accepted commit to be verified on the remote when a binding exists, then the server creates `merv/accepted/<workflow>/<instance>` with `ensureBranch` after commit, retried by `reconcile`. Dependents and base jobs fetch accepted commits through these refs, so work branches need no retention guarantee and later ref housekeeping has nothing to honour there.

**Fetch.** At workspace preparation the runner fetches every commit id in the frozen references: `base`, `resume`, `mergeWith`, `leaves[]`, `baseLeft` and `baseRight`. The existing `syncGitHub` does this by commit id. Its filter accepts only 40-hex strings today (packages/runner/src/index.ts:441-461) and must accept 64-hex as well, or a sha256 repository would silently lose references.

**Resume.** `references.resume` is the unit's `pushed_oid` (equal to `head_oid` by the gate above). In the persistent slot: no local branch → create it at `resume` with the recorded base `references.base`; local head is an ancestor of `resume` → fast-forward; equal → nothing; diverged or ahead → keep the local head under `refs/merv/orphans/<slot>/<oid>` and reset to `resume`. The server's captured, published head is the authority.

**Large files.** `code.commit` and capture already refuse any changed file over 50 MiB at three points (workspaces.ts:555-581, 835-853, 854-876), so every commit a runner makes is clean, and every merge input is such a commit. A scan of pushed history is therefore unnecessary. The same tree check is applied to the results of `code.merge` and `base.merge`. The recipes of the new versions tell workers that outputs over a few MiB go to artifacts or blobs and the repository keeps a pointer file; an artifact holds at most 2,000,000 bytes, larger outputs go to blobs.

## The check command

A human project admin sets one shell command per project with `code.settings_set`. Its text and hash are frozen into each base command. It runs once per base record, when the record is created by an automatic merge, on the runner, inside the worker sandbox profile, with no credentials. It can turn a clean merge into a merge task. It can never pass anything: acceptance always needs a review. Results of merge tasks are not run through it by the server; the command is quoted in the merge brief and in the task's checks, and the reviewer judges it. `exit != 0` is `check_failed`. A timeout, a sandbox launch failure or a signal is `check_error` and costs one retry before it counts as a failure, so a slow runner does not create a reviewed task with nothing to merge. Every record stores the hash of the check it was made under, or NULL.

## `code.merge`

A session-bound command for merge tasks and consolidations only. Input `{ oid, expectedHead, requestId }`. The server requires `oid` to be one of the session's frozen references (`mergeWith` or `leaves`). The runner requires a clean worktree and refuses otherwise, so uncommitted work is never overwritten. It runs `merge-tree HEAD oid`. Clean → a deterministic two-parent commit through the same fenced `update-ref` transaction as `checkpointCommit`. Conflict → the conflicted tree, with markers, is written into the worktree, and `pending_merge_oid` is set on the slot; the next `code.commit` adds it as the second parent and clears it. A capture during a pending merge records a single-parent WIP commit and keeps `pending_merge_oid` for the next session. The conflicted paths go into the review context. There is no scan for conflict markers: repositories legitimately contain them in documents and fixtures, and the containment receipts plus the independent review are the control. Workers still have no write access to Git metadata (docs/CODE_OPERATIONS.md); this is why a merge must be a runner operation.

## Consolidation over leaves

A new Git consolidation version (consolidation@5; every existing consolidation policy row is published and immutable) starts from `main`, pinned at its first lease, in a persistent slot with `perBase: false`, and is granted `code.commit`, `code.operation` and `code.merge`.

- **Candidates** are the accepted code-bearing units among the frozen experiments, plus an optional explicit `taskIds` list.
- **Leaves** are the candidates that are not in the lineage ancestry of another candidate. Merging a leaf carries its ancestors.
- `code.consolidationInputs` returns the raw leaf commits as `references.leaves`. Results of already merged base records that cover several leaves are offered as additional, optional inputs, so a conflict someone already reconciled can be reused. They do not replace the leaves: decisions are made after the lease, and a record that covers a leaf the consolidation later drops must not be forced on it. Which inputs were merged is decided by containment.
- **Decisions and ancestry.** At submit, `drop(X)` is refused with `consolidation_drop_has_dependents` when any unit decided `retain` or `adapt` has X in its ancestry. The honest decision is `adapt`: revert or rework X inside the consolidation branch. A retained non-leaf is carried by its descendant.
- **Earlier consolidations.** `consolidationInputs` flags every leaf whose lineage contains a unit that an earlier consolidation dropped or adapted (`code_unit_decisions`). For such a leaf `retain` is refused and `adapt` is required, and the brief names the ancestor. Without this, merging a leaf built on dropped work would bring that work into `main` unnoticed, and a leaf built on work that was reverted on `main` would merge cleanly while the revert silently stands.
- **Verification.** The submission commit's receipt reports which leaf commits it contains. Every `retain` and `adapt` leaf must be contained; every dropped leaf must not. The reviewer's runner reports containment again at attach, and review pass requires agreement.
- **Moving `main`.** Unchanged: sealed proposal → pull request → `mergePublication` by a human project admin (packages/code/src/publications.ts:395-452). It already requests the merge method `merge` (publications.ts:485-491). Squash and rebase must be disabled on the repository, because either destroys the ancestry of every outstanding work branch. One change: the pull request stays a draft until the operator's call, which marks it ready and merges in one operation (today it is marked ready as soon as a passing review exists, publications.ts:352-360; see "Authority"). On completion the consolidation records `centralGit: 'proposed'`; when the publication merges, Code refreshes the cached head of `main`, records it on the consolidation, and writes the `code_unit_decisions` rows.

A consolidation never waits on a base record, so it needs no callback for merge tasks.

## Authority and credentials

**Leased sessions** may call `code.commit`, and `code.merge` on the two kinds of unit that grant it, with a commit the server froze into their references. They never name a branch, a remote, a base or a key. They never hold a GitHub token; it lives only in the Git child's environment (workspaces.ts:1185-1198). They cannot create tasks (`createForCode` is not a tool), cannot change dependencies (owner handle only), cannot retry, block or acknowledge a base, and cannot set the check command. `accepted_oid` is written only in the review-pass transaction after the leased, commit-pinned, independent review. In-tree `.gitattributes` cannot steer the base merge.

**Runners.** The existing transport routes check only `read` at the HTTP layer (packages/api/src/http.ts:693-695); the real gate is that the named session belongs to this runner and host (packages/code/src/transport.ts:52-69). A base job has no session, so that gate must be replaced, not dropped. The five routes `/code/bases/next | grant | verify | complete | release` require all of:

1. a non-session principal with `write` on the project;
2. a runner that is registered and live in Sessions for this caller's owner hash (a small Sessions check that reuses `admitRunner`'s facts, packages/sessions/src/dispatch.ts:1187-1217);
3. for grant, verify, complete and release: the claimed command row — same runner, unexpired claim, matching fencing token, and an operation the command's status allows (fetch while claimed; push only after the server stored a merged result).

An authority test asserts that a plain actor key and a user key are refused on all five routes. Every push target is computed by the server. Transport refuses to mint a target outside `merv/**`, asserted in code and covered by a property test. Tokens are minted per operation, scoped to the one repository with `contents` only, short-lived, revoked on failure (github-client.ts:180-213).

**GitHub is the second lock, and it has limits.** An installation token with `contents: write` can push any ref that GitHub does not protect, and the runner's token and the server's token belong to the same App, so GitHub cannot tell them apart.

- A ruleset with no bypass actors: `merv/base/**`, `merv/accepted/**` and `merv/proposals/**` block updates and deletions (creation still works); `merv/work/**` blocks force pushes and deletions; `main` requires a pull request.
- Code refuses to mint any write grant unless `client.branch(baseBranch).protected` is true. That field is already read (github-client.ts:472-488) and needs no new App permission.
- GitHub's merge endpoint needs, as far as is known, only `contents: write`, so a runner token could merge a pull request that is open and ready. A contents-only token cannot create a pull request or mark one ready (the readiness probe got 403 on pull request access, docs/GITHUB_PUBLICATION_READINESS.md:58). Keeping the consolidation pull request a draft until the operator's `mergePublication` call closes that window. This must be confirmed against the real App before stage 5 ships, and the result recorded in the readiness document.

**The server** is the only writer of `merv/proposals/**`, `merv/accepted/**`, and `merv/base/<key>` for records made by a task. It never writes `main`.

**`main`** moves only through `mergePublication`: project admin, `caller.human && !caller.session && !caller.key`, passing Merv review, matching head, green checks.

**Server-made work.** No system caller exists in Merv today. All server-made writes in this design (creating a merge task, attaching and detaching it) use one caller: a per-project Code service actor, created by Scope on first need, with the `write` role, never review-eligible, and with no credential ever issued, so nobody can act as it. It is constructed only inside Code and handed to owners as a parameter. Using one caller also keeps the fingerprints of replayed `addDependencies` calls identical. `createForCode` must be unreachable from any tool and is covered by an authority test; otherwise it is a way around task creation rules.

**Review independence of a merge task.** Delivery excludes the task's producer and the working session's authority actor from review (packages/tasks/src/index.ts:2213-2217). With the service actor as producer the first exclusion covers nobody. `createForCode` therefore takes `excludedActorIds`, which Code computes: the producers and authority actors of the units behind the two inputs. Tasks merges them into the review request. The owners of the waiting units are not excluded; in a small project that could leave nobody to review.

**Humans** keep their normal powers over a merge task. Marking it failed leads to the next attempt, not to failed waiters.

## Code unloaded, or no GitHub connection

**Code unloaded.** As today: creating or leasing a Git unit answers `code_unavailable` (tests/optional-code.test.ts:194-202), scratch units and research cycles run, and records, commands, receipts and sealed proposals survive (tests/code-unload.test.ts). Every consumer, callback and route in this design is mounted by Code or inside an owner's Code child injection, so none exists without Code. Cursors catch up and `reconcile` runs on reload. A unit that waits on a merge task still holds an ordinary workflow dependency on it, so nothing is mis-gated while Code is away.

**No GitHub connection (runner in local mode).** Everything except push works on one runner, because all objects live in its one bare repository. Base jobs run and skip the push; records are treated as published; the publication gates do not apply. The head of `main` comes from the runner: at start it reports its repository id and the commit of `refs/merv/central` to a Code route, and Code stores it in `code_main_heads` with source `runner`. The server otherwise never learns that commit, and the runner has no fallback from `reference:base` to central (workspaces.ts:253-262). With several local-mode runners objects are not shared, as today: a job whose inputs are missing is released with `inputs_missing` and the record shows `code_remote_unavailable` with the advice to connect GitHub. A consolidation ends with `centralGit: 'not-published'`.

**With GitHub,** `code_main_heads` is refreshed by `reconcile`, after every publication merge, and whenever a grant reads the base branch (transport.ts:113-140). The lease transaction reads the cache and never calls GitHub.

**Connecting GitHub later, or changing the binding.** Records are keyed by commit ids, which do not depend on the remote. Commands freeze the binding revision and are cancelled and re-issued by `reconcile` when it changes.

## Migration of live work

Nothing published or deployed changes. `task@1,2`, `experiment@1,2`, `consolidation@1–4` and `research@2–4` are published and immutable in tests/fixtures/published-policies.json. `task@3,4` and `experiment@3–7` are still marked unpublished there, but instances of them are live, so they are left byte-identical too. All new behaviour arrives on new versions: `task@5` (Git, automatic base), `task@6` (the same plus the `code.merge` grant, used by `task.merge`), `experiment@8`, `consolidation@5`.

- Live units keep their policies, their explicit bases, their `merv/checkpoints` and `merv/captures` push targets and their local branches until they finish. A unit with no `code_units` row is legacy.
- A new unit may depend on a legacy done task. The frontier reads `data.codeRef`, else `data.deliveryCode.headOid`, the field Tasks and Experiments read today (packages/tasks/src/index.ts:1610-1645). Its lineage is unknown, which only disables ancestor pruning. Its accepted commit is reachable on GitHub through its capture or checkpoint ref.
- `baseTaskId`: for one deprecation window, create with `baseTaskId` still produces `task@4` or `experiment@7` exactly as today, so research change specs in flight keep working. Without it a Git unit gets the new version and an automatic base. Later `baseTaskId` is accepted only as an assertion ("must be on the frontier") and then leaves the tool schema; no workflow version changes, because the new versions never read it.
- Runner ledgers are untouched. Local branch naming stays; only the remote name is new. Old remote refs stay. Nothing is pruned.
- New work branches make `merv/checkpoints` and `merv/captures` redundant for new versions, which do not push them.

## Staged implementation

Each stage ships on its own, on both backends, with the published-policies, optional-code and code-unload suites green.

### Stage 1 — Unit registry and automatic base from one dependency

Delivers `task@5` and `experiment@8`: the base is derived from dependencies, pinned at first lease; a unit with no code dependency pins the cached head of `main`; a frontier of two or more is refused at creation with `code_base_multiple_unsupported` until stage 3.

Steps: contracts (`CodeRef`, resolution, blockers); `code_units`, `code_main_heads` and twins; `declare`, `resolve` (single only), `baseStatus`, `workspaceReferences`, `accept`; the main-head refresh (GitHub reads, runner report route); the `lease.role` gate, evaluation blocker and `uncountedOfferCodes` entries; Tasks and Experiments wiring, including re-declare after a Research replan and `code_base_pinned` when a code-bearing dependency is added to a based unit; new fixture rows only; docs.

Tests: T2 depends on a done Git T1 without `baseTaskId` and the reviewer sees T1's accepted commit as base; git → none → git and the diamond (I8); a unit with an unaccepted code dependency is ineligible, shows a named blocker, and records no launch failure and no hold (I12); the base is write-once after `main` moves; empty main-head cache → `code_main_unknown`, then startable after a runner report in local mode; Code unloaded (I9); old fixture rows untouched.

### Stage 2 — One branch per unit, pushed at every commit and session end

Delivers work-branch push, resume on another machine, accepted refs, and the publication gates.

Steps: transport target kind `work` with the expected value computed at grant time, verify → advance `pushed_oid`; assertion that every target starts with `merv/`; refusal to mint write grants when the base branch is unprotected; runner ancestor check, push classification, retry on the loop; resume rule; 64-hex references; lease gates `code_head_unpublished` and `code_push_rejected`; `merv/accepted/**` at accept; the two admin tools; large-file guidance in the new recipes; the ruleset checklist in the readiness document.

Tests: two sessions on one unit give one branch advanced by fast-forward; a stale expected value → `workspace_remote_ref_conflict`; a non-descendant head is refused before any push; a second ledger resumes from `references.resume` with an identical tree; a diverged local head is kept as an orphan and reset; a capture push that fails closes the session, blocks both leases, and is later superseded by a newer push; a rejected push is terminal and visible, not retried; a session, a key and a non-admin are refused on the admin tools; the accepted ref is created once and a second accept path cannot move it; no target outside `merv/**` for any operation; local-mode suites unchanged.

### Stage 3 — Base records, the merge job, the check command

Delivers automatic merged bases with the complete lattice. A conflict parks the record with a visible blocker until stage 4.

Steps: `code_bases`, `code_base_members`, `code_base_commands`, `code_settings` and twins with triggers; the planner as a pure module; `ensure`, promotion, completion, `code.units.v1`, `reconcile`; the five runner routes with the three-part authorisation and the Sessions runner check; contracts for the command and receipt; runner `mergeBase()` (ancestor shortcut, pinned attributes, merge-tree, fixed date, tree size check, sandboxed check, server-first completion, then create-only push), `runner_base_jobs`, a loop step run with spare capacity; claim renewal; base facts in references and review context; the recheck at reviewer attach; tools `code.base_get`, `code.base_list`, `code.settings_get`, `code.settings_set`, `code.base_acknowledge`; removal of the stage 1 refusal.

Tests: planner determinism, reuse, direct merge of overlapping records, tie-break, blocked and in-flight records kept as candidates, termination (I2, I4, I5); three experiments created concurrently over two tasks → one record, one command, on both backends with parallel Postgres transactions (I3); a record inserted while its input completes is promoted (by completion, by `ensure`, and by `reconcile` alone); a runner whose claim expired cannot complete, and a second differing receipt is `code_receipt_conflict` (I7); nothing is pushed for `conflict` or `check_failed`; a unit is held by `code_base_unpublished` until the base ref is verified; claim expiry re-queues, an unreachable remote releases and never conflicts (I10); check passes, fails, errors once then passes, errors twice; a job with a check is not offered to a runner without a sandbox; the `merge=union` fixture conflicts; an actor key and a user key are refused on all five routes; a recheck with a different tree blocks review pass until acknowledged by a human admin; immutability triggers.

### Stage 4 — Merge tasks

Delivers one reviewed merge task per conflicted record, attached to every present and future waiter, re-issued on failure up to the limit.

Steps: the Scope service actor; `code.merge` in contracts, Code and runner (`pending_merge_oid`, two-parent `code.commit`, clean-worktree rule), containment in the merge task's commit and attach receipts; `task@6`, the `task.merge` type and recipe, `createForCode` with `excludedActorIds`, the brief, the consumer `tasks.code-merge.v1`; the owner callback in Tasks and Experiments (a merge task is a task, so "an experiment depends only on tasks" holds); `assignMergeTask`, the accept-time containment check, the server-made base ref, `unitClosed`, blocking, `code.base_retry`; merge-task gate in `baseStatus`; fixtures.

Tests: a conflict with three waiting experiments → exactly one merge task, a dependency of all three, and a fourth created later gets it at creation; a replayed event creates nothing; acceptance makes the record `merged/task`, waiters start from its commit, and {A,B,C} merges C into it; a delivery that lacks an input → `code_merge_incomplete`, and so does review pass; merge task failed → the edge is gone in the same transaction, the waiter's next action is never `mark_failed` (I11), attempt 2 is attached; after the limit → blocked, no edge, retry by a human admin only; an escalated merge task shows its gate on every waiter; nested {A,B} resolving under {A,B,C}; reviewers named in `excludedActorIds` are refused; `createForCode` is unreachable from every tool; runner: clean merge, conflicted merge then commit with two parents, capture mid-merge, dirty worktree refused; Code unloaded with a merge task in flight.

### Stage 5 — Consolidation over leaves

Delivers `consolidation@5`.

Steps: `consolidationInputs` (leaves, optional record results, flags from `code_unit_decisions`); the version 5 policy and wiring, optional `taskIds`, the drop rule, the "ancestor previously dropped or adapted → adapt required" rule, containment at submit and at review pass; the publication pull request stays a draft until `mergePublication`; on merge, refresh the main head, record it on the consolidation, write the decision rows; fixtures and docs.

Tests: E2 built on E1's chain, plus E3 → leaves {E2, E3}; drop(E1) with retain(E2) refused, adapt(E1) accepted; a submission missing a retained leaf or containing a dropped one is refused; reviewer containment disagreement blocks pass; a leaf built on a unit dropped by an earlier consolidation cannot be retained; a merged record is offered as an optional input and dropping one of its leaves still passes when the raw other leaf is merged; `mergePublication` refuses sessions and keys, and the pull request is a draft until it runs; `consolidation@2/4` instances complete unchanged.

## What the challenges changed

Adopted, after checking each against the code:

- A pending base is raised in `lease.role`, not in `references()`, and the first leasable state is gated. Verified: `dispatchCandidates` never runs `references()`, and a 4xx at offer time is a counted launch failure.
- A failed merge task is detached from its waiters in the transaction that fails it, and the Code blocker is the gate. Verified: evaluation suggests `mark_failed` on `dependency_failed`.
- The server accepts a base result before anything is pushed; claims carry a fencing token and outlast the check; `conflict` and `check_failed` never push.
- The head of `main` is a Code cache, fed by GitHub reads or by the runner's report in local mode. Verified: the transport's base read happens after the lease, and local mode has no transport.
- Base-job routes require a live registered runner, `write`, and the claimed command. Verified: the existing routes check only `read` and rely on a session match that a job does not have.
- The auto-merged base is put in front of the reviewer and recomputed by a second runner.
- Work leases, not only review leases, wait for the head to be published; the expected remote value is computed at grant time; superseded pushes succeed.
- `merv/accepted/**` refs, a ruleset over `merv/**`, a runner-side ancestor check, and a refusal to mint write grants without branch protection.
- Push results are classified; a rejection is terminal and visible; two admin tools cover the dead ends. The statement that unpushed commits may be rewritten was wrong and is gone.
- Consolidation remembers earlier drop and adapt decisions, offers raw leaves, and treats record results as optional inputs.
- In-tree attributes are pinned for the base merge. Verified by experiment on Git 2.39.3.
- A stalled merge task shows its gate on the waiters. Blocked and in-flight records stay planner candidates, and dependents resolve in ascending (|S|, key) order. `code.merge` needs a clean worktree and has no marker scan. `check_error` is separate from `check_failed`.
- Merge-task reviewers exclude the authors of both sides. Code decides blocked or conflicted before it emits, owners see an opaque ref, and one service caller makes all server-made writes.
- Simplifications: no `waiting` state, no waiter table, no push twin table, no runner outbox, no denormalised input keys, no consolidation consumer, no subscription to every `workflow.transition` (a direct `unitClosed` call), containment arrays only where they are used, no "force merge method" step (it is already `merge`), no history scan.

Refused:

- "Postgres lost wakeup". The claim rests on Postgres write transactions being plain `BEGIN` under READ COMMITTED. They are, but each takes a per-schema advisory transaction lock first (packages/state/src/postgres.ts:227-232), so writers are serialised exactly as on SQLite, and the second transaction's statements run after the first has committed. The interleaving described cannot occur. The idempotent promotion rule was kept anyway, because it also covers a crash between a completion and its propagation and costs nothing once `waiting` is derived.
- "The edge does not gate, so exactly-once attachment is unnecessary" was adopted as a statement about gating, but the edge itself stays: decision 3 makes the merge task a dependency of the waiting unit.
- A policy-level fallback from `reference:base` to `central` for local mode. It would add a member to the execution policy union in Workflows for one case, and leave the pin to be learned after the fact from the attach receipt. The runner's report gives the same result with the base pinned before the lease, as in GitHub mode.

## Risks

- The runner's and the server's tokens come from the same App. Until the draft-until-merge rule is confirmed against real GitHub, a runner token may be able to merge a ready consolidation pull request.
- An operator who squashes or rebases in the GitHub UI destroys ancestry for every outstanding branch. Disable both merge methods on the repository.
- The check command runs repository code on the runner. It must run in the sandbox without credentials, and a flaky check creates needless merge tasks; keep it fast and hermetic.
- `merge-tree` can differ across Git versions in edge cases (rename detection, attributes). One result per key keeps this from forking state; the recheck turns a difference into a visible dispute instead of silence.
- Session-final capture commits have no fixed date (workspaces.ts:582-600) and cannot be re-derived on another machine. Accepted commits are pinned by id, so never rely on re-creating one.
- Lineage knows only Merv-made ancestry. Pruning can miss, at the cost of one `fast_forward` job.
- Any base blocker an owner forgets to lift into evaluation makes work vanish silently, because dispatch swallows 409s. Stage 1 includes the blocker and a test per owner.
- The service actor and `createForCode` have no precedent. If the hook is reachable from a tool it is a bypass.
- A replan before start can leave a `resolving` record with no waiters and a merge task nobody needs. It is harmless and reusable, but costs agent time; an operator can fail it.
- `syncGitHub` caps pinned references at 200, which bounds the number of consolidation leaves.
- The greedy cover is not an optimal set cover. Dependency sets are small, and a stable choice matters more.
- Stage 3 without stage 4 parks conflicted records. Ship them close together.
- The recheck can dispute a correct merge when runners run different Git versions. That is work for an admin; pinning one Git version across runners avoids it.

## Open questions for the owner

1. **Who produces a server-made merge task?** Recommendation: a per-project Code service actor with no credential, never review-eligible. The alternative, the owner of the first waiting unit, acts in a person's name without the person and depends on arrival order.
2. **Does the planner reuse only merged records, as decided, or also records in flight and blocked?** Recommendation: all of them, merged winning ties. Otherwise {A,B,C} created while {B,C} is with a merge task would route around it and ask for the same B/C resolution twice, which decision 4 exists to prevent.
3. **Merge partial frontiers early?** When a unit depends on A, B and C and only A and B are accepted, pre-merge {A,B}? Recommendation: no. Resolve only a complete frontier; a replan may abandon the set, and the lattice still shares {A,B} if anything else needs it.
4. **Should a unit whose dependencies are all already consolidated start from `main`?** By decision 2 it branches from the dependency's accepted commit, which lacks everything else consolidated since. Recommendation: yes — when every frontier commit is recorded as contained in the cached head of `main`, the base is `main`. It is cheap (lineage plus `code_unit_decisions`) and keeps long-running research from drifting away from `main`. Merging `main` into every base is not recommended.
5. **What may a consolidation merge besides its frozen experiments?** Recommendation: an optional explicit `taskIds` list, decided per unit like experiments, never implicit.
6. **How many merge-task attempts before a record blocks?** Recommendation: 3, as a project setting.
7. **Is `baseTaskId` removed?** Recommendation: keep it one release as the legacy path, then accept it only as an assertion, then drop it.
8. **How is protection of `main` verified?** Recommendation: enforce `protected: true` on the base branch before any write grant (no new permission), and keep the ruleset details as an operator checklist. Grant "Administration: read" only if the checklist proves unreliable.
9. **May the consolidation pull request stay a draft until the operator merges?** It changes what people see on GitHub between review and merge. Recommendation: yes, unless a test with the real App shows that a contents-only token cannot merge.
10. **Is a disputed recheck blocking?** Recommendation: yes, with a human admin's acknowledgement as the way forward, and one Git version across runners as the way to keep it rare.
11. **Retire `merv/checkpoints/*` and `merv/captures/*` for new versions?** Recommendation: yes; keep them for legacy versions; never delete existing refs automatically.
12. The relayed request also asked to merge the existing branches and push to production before this workflow. This design run was confined to one new file on an isolated branch, with no push and no branch switch, so that step was not performed here and remains with the owner or the orchestrator.
