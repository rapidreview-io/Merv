# Git model

Status: accepted design, 2026-09-21. Written by GPT-6 Astra across three rounds (an adversarial review of the first
design, its own redesign, and a revision after the implementing engineer's objections), and reviewed by Claude Fable.
It implements the owner's ten decisions recorded below and supersedes the first draft of this file. Nothing here is
implemented until its stage says so.

## Implementation status

Stage S1 is being implemented in two parts. The first part is in the code: the opaque blocker projection `wf_blockers` with its reads in `workflow.status_and_next`, the overview and `session.stuck` (`work_blocked`); the four Code tables `code_projects`, `code_units`, `code_edges` and `code_operations` on both backends; `code.local.bind`, `code.unit.get` and `code.status`; and immutable acceptances written by Tasks and Experiments inside their successful review transactions, for every workflow version, labelled `legacy-local`. Base derivation, pinning in `lease.acquire`, `task@5` and `experiment@8` are the second part. The operator's view is in [CODE_OPERATIONS.md](CODE_OPERATIONS.md#units-acceptance-and-the-local-binding).

Two choices differ from the text below and hold for S1. Whether a dependency without an acceptance carried code is read from the workflow version's persisted execution manifests (did any state declare a workspace), never from a loaded plugin, so the answer is the same with its owner unloaded. `code.local.bind` requires a signed-in human administrator and moves main only by compare-and-set, because decision 1 lets no agent move main.

## The owner's decisions

1. One branch per unit of work. `main` is consolidated, reviewed research: it moves only at consolidation, and no
   agent or runner can move it.
2. A unit gets its code by branching from its dependencies' accepted commits, derived automatically.
3. Several code-bearing dependencies are auto-merged; when that fails the server creates one reviewed merge task,
   which slots in as a dependency of every unit waiting on it.
4. No duplicate merges: one base record per distinct set of accepted commits, one merge, at most one merge task per
   key, with resolution rounds on that one task.
5. Overlapping sets are reused on the fly: every merge has two parents, and every intermediate union is its own record.
6. A clean auto-merge is not proof the code works: an optional project check command, a failing check treated as a
   conflict, and every base record saying how it was made. (The check command ships with the sandbox in S5; it never
   runs on the server host.)
7. A unit's work is on the shared remote after every session end, so another machine can resume or review. The shared
   remote is Code's own repository; GitHub is its asynchronous mirror and the place `main` lives.
8. Large files never enter Git.
9. Consolidation merges the retained frontier of frozen candidates, with drop and adapt reconciled with ancestry.
10. Only the Code plugin knows Git. Everything works with Code unloaded or with no GitHub connection.

Code is the canonical shared remote. A session handoff completes when its capture is durable in Code and its unit head advances under the writer fence. GitHub mirroring is asynchronous. GitHub downtime does not block handoff, resume, review, acceptance, or base construction.

GitHub is required for initial import from GitHub, mirror operations, PR operations, and publication to connected main. Existing work uses Code’s retained objects and last verified main snapshot.

No repository files were modified.

**1. Units, acceptance, and automatic bases**

A unit has one writable branch, one immutable base pin, and at most one immutable acceptance. Its work branch may contain unreviewed checkpoints; its acceptance names the exact reviewed submission.

Tasks and Experiments carry opaque Code references. Only Code interprets commits, trees, refs, or ancestry. Runner’s Git implementation becomes a Code-owned workspace driver; its scheduler remains generic.

The owner plugin records acceptance inside its successful review transaction:

```ts
acceptUnit(tx, {
  unitId,
  terminalRevision,
  submissionRef,
  reviewRef,
  codeRef: null | OpaqueCodeRef,
});
```

Code verifies the submission, review provenance, object-admission receipt, and quarantine status. GitHub mirror completion is **not** an acceptance requirement.

For each declared dependency:

1. Require workflow success.
2. Use its code acceptance, stopping traversal along that path.
3. For an explicitly code-less success, traverse its dependencies.
4. Block on a code-bearing success whose acceptance cannot be verified.
5. Deduplicate commit IDs while retaining every contributing acceptance reference.

Zero resulting commits uses the project’s pinned, admitted main snapshot. One uses that accepted commit automatically. Several request a set-keyed base.

The existing `baseTaskId` mechanism reads a done task’s `deliveryCode.headOid`; it remains a legacy adapter, not the new resolution algorithm. [tasks/index.ts:1611](../packages/tasks/src/index.ts:1611)

Reconciliation prepares the base request. **`lease.acquire` pins it**, rechecking dependency revision, acceptance health, provider availability, and writer availability in that transaction. `references()` only reads the pin. This matches the existing acquisition order. [workflows/index.ts:735](../packages/workflows/src/index.ts:735)

For experiments, pin at the first planner lease; execution inherits that pin. Preserve the feasibility gate and the current distinction between planning without a checkout and execution with one. [experiments/program.ts:63](../packages/experiments/src/program.ts:63), [experiments/program.ts:950](../packages/experiments/src/program.ts:950)

Declared dependencies cannot change after pinning. Replanning creates a new unit.

**2. Canonical disk repository and bundle transport**

Adopt one Code-owned bare repository per project:

```text
/var/lib/merv-ts/code/<project-id>/repository.git
/var/lib/merv-ts/code/<project-id>/quarantine/<operation-id>/
```

No S3 implementation, pack-chunk service, or object-manifest database in the first version.

Code creates the repository with an empty template and controlled configuration. It imports objects, never another repository’s configuration, hooks, alternates, or refs wholesale.

Initial import comes from:

- **Connected project:** Code fetches the selected GitHub repository and main using a server-held read token.
- **Local project:** an operator supplies a bundle from the configured local source. An explicitly allowlisted server-local source is also possible; an agent cannot name arbitrary server filesystem paths.

Code records the project identity, object format, admitted root, and, when connected, GitHub’s numeric repository identity. A reused URL is not the same repository.

**Upload protocol**

1. Code creates an operation bound to project, unit, generation, expected head, proposed head, and authorized prerequisite commits.
2. Runner creates a bundle excluding the prerequisites Code named.
3. Code streams it to quarantine, checks the bundle header and prerequisites, indexes its pack with strict verification, and checks connectivity against the admitted repository.
4. Code validates the newly admitted closure.
5. Objects migrate into the canonical repository and are hardened to disk.
6. A fenced ref transaction advances the unit branch and creates an immutable operation receipt ref.
7. The database records completion. Only then does Code acknowledge the handoff.

Bundles support prerequisite-based transfer; `git bundle verify` checks that prerequisites exist and are fully connected. Reject shallow or filtered bundles in the first version. [Git bundle documentation](https://git-scm.com/docs/git-bundle)

Use a quarantine object directory with the canonical object directory as a **server-controlled** alternate. Never accept alternates from an upload. Bundle ref names do not authorize destination refs.

Validate all uploaded objects, including surplus objects, and reject unrelated surplus closure rather than retaining arbitrary hidden history.

**Download protocol**

`POST /code/v2/bundle-download` accepts an authorized opaque workspace reference and a bounded list of runner haves. Code creates a bundle for the exact requested checkpoint, excluding only haves it recognizes in the authorized project.

The response includes the bundle hash, exact head, required prerequisites, and pending-merge metadata. A lying or incomplete have list can only break that runner’s import; it cannot change the server’s head. Retry without those haves.

Temporary export refs are private implementation refs, not additional work branches.

**Durability and database/filesystem recovery**

Git defaults are insufficient for the stated acknowledgment guarantee. Configure `core.fsync=all`, `core.fsyncMethod=fsync`, and explicitly sync migrated files and containing directories. Git documents that its usual defaults can lose recent loose objects after an unclean shutdown. [Git configuration documentation](https://git-scm.com/docs/git-config)

A database transaction and a Git ref transaction are not atomic together. Use the operation journal:

```text
prepared → objects_durable → refs_applied → completed
```

Before `refs_applied`, persist the exact expected-old and target. Update the unit ref and `refs/merv/receipts/<operation-id>` in one Git ref transaction. Recovery either finds that exact receipt or retries the same expected-old update. It never invents a different target.

A unit cannot change generation while an admitted **local** ref operation is unresolved.

First-version disk deployment supports one active Code repository writer process per volume, enforced with a process-lifetime OS lock. Per-project operations are serialized within it. PostgreSQL does not make a shared filesystem safely writable by several independent Code services.

**Limits**

- Blob: 50 MiB.
- Upload: 512 MiB compressed.
- Expanded new objects: 2 GiB.
- New objects per upload: 100,000.
- Project disk quota and reserved free-space floor.
- Bounded concurrent imports and bundle exports.
- No automatic pruning of authoritative receipt, acceptance, or base refs.

Oversized initial repositories require an operator-controlled incremental import under the same per-transfer limits.

Ordinary backups must include both database and repositories, with a documented restore procedure. A simple consistent backup pauses Code mutations, drains local operations, snapshots the database and Code directory, then resumes. GitHub is an additional replica, not a complete backup of pending or quarantined work.

Compared with the previous store, this loses independent object-store replication and easy multi-server access. It preserves hash verification, retention refs, crash recovery, and exact-head transport. Disk loss between backups and mirror completion can lose acknowledged work; the owner must accept that recovery point.

**3. Admission without new npm dependencies**

Use Node built-ins and installed Git. No new npm packages.

Admission examines the entire newly introduced reachable history, not merely the final checkout diff:

- Object integrity, connectivity, parent lineage, and object format.
- Blob size, expanded size, and object count.
- Allowed tree modes.
- Invalid or dangerous paths, case/path collisions relevant to supported runners.
- Symlink targets that would escape the workspace.
- Gitlinks/submodules: unsupported initially.
- Project deny globs, using a small documented matcher supporting literals, `*`, `?`, and `**`.
- A versioned built-in set of high-confidence credential patterns: private-key blocks and selected well-defined token prefixes with length/character constraints.

Do not treat every high-entropy string as a secret. Scan blob contents and commit/tag messages; diagnostics identify paths and object IDs without echoing suspected credentials.

Findings prevent admission, acceptance, and GitHub mirroring. Keep the bundle in restricted Code quarantine for an operator. It is not available through ordinary project downloads.

A rejected final capture remains durably preserved but does not advance the admitted head. The unit shows `code_capture_quarantined`. An operator can correct a false positive through a recorded, scoped exception or recover sanitized work from the last admitted head.

This scanner is **not proof of secret absence**. Large objects created on a compromised runner can exist locally; the enforceable boundary is admission into Code’s canonical history and GitHub.

The current capture check only examines changed checkout files before `git add`; it cannot enforce closure-wide admission. [runner/workspaces.ts:555](../packages/runner/src/workspaces.ts:555)

**4. Writer generations and asynchronous mirroring**

The canonical lifecycle is:

```text
idle → reserved → active → closing → closed
                                  ↘ recovery_required
```

`closed` means the final capture is durable and the canonical unit head is committed. There is no `sync_pending` writer state.

Each operation carries:

```text
unitId, generation, sessionId, leaseId,
expectedHead, requestId, inputFingerprint
```

After ordinary session authority closes, a narrow source-authenticated finalizer may submit exactly one frozen final capture. It cannot execute tools, change dependencies, or reopen the writer.

Runner confirms process termination before capture. This preserves the existing separation between session handoff and subsequent final capture. [sessions/index.ts:645](../packages/sessions/src/index.ts:645), [runner/index.ts:660](../packages/runner/src/index.ts:660)

A successor gets generation `g+1` when:

- `g` has closed; or
- An operator fences `g` at the last durable checkpoint, acknowledging possible unseen edits, and all local ref operations have been resolved.

A stale finalizer receives `code_generation_stale`. Its bytes may be retained for operator recovery, but cannot advance a unit.

Every successor prepares the exact canonical head from Code. GitHub’s branch tip is irrelevant to preparation.

**Submission and trailing WIP**

A submission fixes its reviewed commit. Final capture may preserve later WIP on the branch without changing that submission. Review checks out the submission, not the branch tip.

A passing review accepts only that commit. A changes-requested round resumes retained work with the earlier submission and feedback.

**Pending second parent**

Persist with each affected checkpoint:

```text
planRef, resolutionRound, currentHead,
leftInput, pendingSecondParent, conflictEvidenceRef
```

Partial resolution can produce ordinary first-parent checkpoints. Completing the merge creates exactly two parents: the current checkpoint descending from the planned left input, and the frozen right input. Require the second parent even if the tree is unchanged.

Another machine reconstructs this state from Code; it does not depend on `.git/MERGE_HEAD`. Existing workspace snapshots have no pending-merge field. [runner/workspaces.ts:1370](../packages/runner/src/workspaces.ts:1370)

**Mirror lifecycle**

Mirroring has separate operation state:

```text
queued → running → mirrored
             ↘ retry_wait → blocked
```

The UI reports canonical head, mirrored head, oldest pending time, last error, and affected refs. Mirror lag blocks publication when required objects/refs are unavailable on GitHub; it does not block ordinary work.

Only Code writes remote refs:

- Work branches advance by fast-forward.
- Acceptance/base refs are create-only.
- Per-ref operations serialize; queued work-branch updates may coalesce to a newer descendant.
- Accepted/base refs are not coalesced away.
- An older delayed push cannot roll a branch back.

On unexpected remote divergence, stop that ref’s mirror with `code_mirror_diverged`. Continue using Code. Operator recovery can preserve the foreign remote tip and restore the mirror through an explicit repair operation; there is no automatic force-push.

**5. Server-side automatic merges**

Use Code itself as the first merge executor: a bounded child process, not a new service deployment.

`git merge-tree --write-tree L R` followed by `git commit-tree` is suitable **under controlled configuration**. Modern two-commit merge-tree mode arrived in Git 2.38; require at least that feature set and pin the exact tested Git package in the release image. Record the build identity and merge configuration in each plan. [Git 2.38 release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.38.0.adoc)

The command does not require a checkout. Write generated objects into an operation quarantine directory, with canonical objects available read-only as prerequisites.

Controls:

- Empty template and sanitized environment.
- No system/user Git configuration.
- No hooks, credential helpers, signing, replace objects, grafts, external diff/merge drivers, or filters.
- `merge.renormalize=false`.
- Fixed locale, rename settings, and directory-rename policy.
- No network-enabled Git protocols in merge/import workers.
- Structured exit status, output, and diagnostics; exit 1 is a conflict, not an empty successful response.

The existing runner wrapper provides useful configuration controls, but its `allowOne` path discards exit-1 output; do not reuse that behavior for merge-tree. [runner/workspaces.ts:1424](../packages/runner/src/workspaces.ts:1424)

In-tree `.gitattributes` can select a merge driver, but its executable definition comes from Git configuration. Allow built-in text/binary/union semantics; no custom driver configuration is installed. Document that custom driver names receive Git’s behavior without their external implementation. Their use should surface a warning in resolution evidence, not silently install or run a command. [Git attributes documentation](https://git-scm.com/docs/gitattributes)

Rename detection is deterministic only for the pinned engine, inputs, ordering, and settings. No guarantee is made across Git versions. Freeze commit metadata before execution and retain a completed candidate before retrying acknowledgment.

Git’s merge machinery handles multiple merge bases. Preserve its conflict output; do not pick one merge base or infer success from the absence of conflict markers. [Git merge-tree documentation](https://git-scm.com/docs/git-merge-tree/2.38.0)

**Production deployment**

The Dockerfile does not explicitly install Git. Add Git, CA certificates, and Linux resource-limit utilities to the runtime image before `USER node`; assert the supported Git version during build/startup. [deploy/Dockerfile:9](../deploy/Dockerfile:9)

Repositories, bundles, and quarantine use the mounted `/var/lib/merv-ts` volume. They cannot use the current 64 MB `/tmp`. Preserve the read-only root filesystem and dropped capabilities. [deploy/compose.yml:12](../deploy/compose.yml:12)

Initially allow one automatic merge child globally, with a 120-second wall deadline, bounded CPU/address space/file size, bounded diagnostic output, and project disk reservation. Kill its process group on timeout/cancellation. Resource exhaustion is infrastructure failure, not a semantic merge conflict.

Repository code is not intentionally executed, but Git still parses hostile input. Running it in the server container retains a parser-exploit and resource-exhaustion risk.

**Project checks**

Checks remain disabled until S5 supplies the OCI sandbox adapter. A configured command without that adapter returns `code_check_unavailable`; never execute it on the Code host.

The later adapter advertises `code.check.oci.v1`, uses a pinned image, unprivileged execution, no network/secrets/host sockets, read-only source, bounded scratch, process-tree termination, and measured usage.

There is one logical automatic check per base record. Recorded failure requires resolution; it does not trigger another automatic merge/check loop. Resolution rounds supply reviewed verification evidence. A crash before durable check output may require physical re-execution.

**6. Base DAG, resolution, and recovery**

For each nonempty accepted-commit set:

```text
key = SHA-256(canonical(sorted(unique(fullCommitIds))))
identity = (projectId, key)
```

Compare stored members on lookup. Object format is immutable per project.

A singleton resolves to its accepted commit. Larger records freeze two input base keys, their order, engine configuration, and optional check specification. Inputs must be proper subsets whose union is exact.

Planning occurs transactionally:

1. Start with the largest existing eligible proper-subset record.
2. Break ties by key.
3. Fold with the largest eligible record adding uncovered members.
4. Reuse or create each intermediate union.
5. Stop at the requested set.

Quarantined records are ineligible. Unresolved healthy records remain dependencies; do not create another plan to bypass them. First committed plan wins and never changes.

SQLite and PostgreSQL already serialize State writers; retain unique constraints as the final protection. [state/sqlite.ts:53](../packages/state/src/sqlite.ts:53), [state/postgres.ts:227](../packages/state/src/postgres.ts:227)

States:

```text
waiting_inputs → queued → running → resolved
                            ├→ retry_wait → blocked_infra
                            └→ awaiting_resolution
operator: suspended | cancelled
health: healthy | quarantined
```

The result fields are write-once within the base row: head, tree, receipt, evidence, and `method=single|auto|task`. No separate result table.

A fast-forward can reuse an input commit. Every newly created merge commit has exactly two parents.

Objects and retention refs become durable before the result seals. A claim epoch fences completion. “One attempt” means one logical automatic attempt and one authoritative result; crash recovery may repeat physical computation before durable output exists.

After recorded conflict/check failure, only the resolution task can complete that key.

**One task, multiple rounds**

Store one nullable, unique `resolutionTaskId` on the base row. Creation and linkage are one owner transaction.

The task is service-owned and project-scoped. Its worker policy allows ordinary authorized project runners to lease it without impersonating the owner or gaining admin powers. This requires a new service-task policy because existing Tasks requires admin when the source differs from its producer. [tasks/index.ts:420](../packages/tasks/src/index.ts:420)

```text
in_progress → in_review → done
                   ↘ in_progress
either active state → suspended
suspended → prior active state, by operator
```

Fail/abandon suspends this task. It never creates a replacement task.

Rounds retain checkpoints, submissions, reviews, and contributor provenance through existing task checkpoints, workflow history, and Reviews records. Context includes exact inputs, frozen plan, conflict/check evidence, current work, pending parent, all prior feedback, and remaining rounds. Existing task carry-forward already retains review history and checkpoints. [tasks/index.ts:1399](../packages/tasks/src/index.ts:1399)

Loop exhaustion records the review verdict, then suspends automation. `workflow.extend_limit` can permit another round; it cannot waive independent review. [workflows/limits.ts:97](../packages/workflows/src/limits.ts:97)

**Provenance and prerequisites**

Reviews receives a hash-pinned provenance certificate through a registered owner capability. It verifies retained source records, not caller-supplied actor lists or Git author strings. Exclude contributors from retained inputs/rounds and their directing authorities. Check reviewer actor and directing authority at claim and submission.

Current Reviews requires exclusions to be justified by retained authorship/authority and currently compares actor IDs at claim. [reviews/index.ts:665](../packages/reviews/src/index.ts:665), [reviews/index.ts:791](../packages/reviews/src/index.ts:791)

Attach the task to every present and future affected waiter as a **system prerequisite**. These edges gate execution and appear in dependency reads, but never contribute commits to base derivation. Include waiters of descendant base records.

Only owner capabilities invoked by reconciliation can create these tasks/edges. Leased sessions receive neither capability. Existing dependency mutation already requires owner-controlled revision checks. [workflows/index.ts:1765](../packages/workflows/src/index.ts:1765)

**Operator recovery**

`code.base.retry` retries infrastructure work on the same record. `suspend`, `resume`, and `cancel` retain identity/history.

Quarantine propagates through base inputs, unit pins, acceptances, and publication candidates. Block new use; fence affected active work into recovery. Unrelated work continues.

A wrong sealed result is never replaced under its key. Corrective reviewed work produces new acceptance identities and new keys. A scoped operator repair grant may expose quarantined inputs to repair work; it does not make the original result healthy. Clear quarantine only for a verified false alarm.

Structural termination follows from proper-subset edges. Jobs have deadlines, retries are bounded, and task rounds are limited. Human absence can stop progress, but cannot remain invisible.

**7. Worked examples**

| Case                                           | Behavior                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two tasks → three experiments on two runners   | Their acceptances produce one `{A,B}` record. One server merge runs. All experiments pin its result and receive separate branches; runner capacity limits execution to two.                     |
| `{A,B}` then `{A,B,C}`                         | Freeze `ABC = merge(AB,C)`. If `AB` is unresolved, wait on it.                                                                                                                                  |
| `{A,B}` and `{B,C}` → `{A,B,C}`                | Tie-break fixes order; freeze `ABC = merge(AB,BC)`. Git handles their shared and possibly multiple merge bases.                                                                                 |
| Conflict → rounds → all waiters                | One task is attached to all affected current waiters. Failed rounds retain work/feedback. A passing round seals the result. Future waiters receive that same completed prerequisite and result. |
| Merge task abandoned                           | Task becomes `suspended`. Waiters name it and the reason. Operator resumes it, extends its limit, or cancels/replans waiters. No replacement task.                                              |
| Runner lost after computing, before durability | No new authoritative checkpoint exists. Recover its local bundle if available; otherwise resume the last durable head. The server merge equivalent may recompute under a new claim.             |
| Lost after durability, before acknowledgment   | Replay recovers the exact receipt.                                                                                                                                                              |
| GitHub down                                    | Captures, successor leases, reviews, acceptances, and base merges continue through Code. Mirror lag is visible. PR operations and main publication wait.                                        |
| Rejected push                                  | Diagnose/retry that mirror operation. Unexpected remote divergence blocks only that mirror/publication path. Never overwrite Code’s canonical head or automatically force the remote.           |

**8. One App and PR publication**

Use the existing App, server-side only. Mint explicit repository-scoped tokens with minimal permissions for each operation:

- Import: Contents read.
- Mirror: Contents write.
- PR creation/update: Pull requests write.
- Required approval status: Commit statuses write.
- Merge: Contents write, plus separate reads needed for inspection.

Validate returned repository IDs, permissions, and expiry. Existing token minting already validates a repository-restricted Contents grant; extend its permission argument instead of inventing another credential service. [github-client.ts:180](../packages/code/src/github-client.ts:180)

Remove v2 use of the existing route that returns a write token to Runner. [transport.ts:213](../packages/code/src/transport.ts:213)

A compromised runner can damage its assigned candidate, withhold edits, or consume its quota. It cannot obtain GitHub credentials, change canonical refs outside its fence, create acceptance, approve itself, or request main publication.

A compromised Code server/App credential has broader repository authority. One-App deployment does not cryptographically separate mirroring from merging.

**Rules and visibility**

Configure:

- Restricted Merv ref updates, no automatic force-push/deletion.
- Main requires PRs.
- Main requires strict up-to-date status checks.
- At least one required status: `merv/consolidation-approved`, sourced from the App.
- The App must not bypass the strict-check/PR rules.
- A separate update restriction may permit the App through its own bypass list without bypassing the strict-check rule.

Read everything the App can inspect and run canaries. Record omitted bypass lists or inaccessible inherited rules as `code_rules_visibility_incomplete`, with the owner’s acknowledgment. Do not refuse project activation solely for incomplete visibility.

GitHub can hide bypass actors from callers lacking write access to a ruleset. Also, its strict setting has no effect unless at least one status check is required. [GitHub rules API](https://docs.github.com/en/rest/repos/rules)

Known failed enforcement is different from incomplete auditing: a canary proving stale PR merges are allowed disables that publication path. Local work and mirroring remain available.

**Keep the PR path**

The new flow is:

```text
reviewed consolidation
→ sealed proposal
→ immutable proposal branch and PR
→ explicit human merge request
→ GitHub merge commit
→ verified publication receipt
```

Proposal branches are immutable publication snapshots, not extra writable unit branches.

The approval status is emitted only for the exact approved proposal head. Updating a branch does not carry the status to another head. No auto-merge, merge queue, squash, rebase, or GitHub “update branch” operation is used.

Before merging, Code:

1. Reads current main and verifies it is contained in the reviewed head.
2. Verifies proposal/head identity, approval status, other required checks, and available enforcement evidence.
3. Rechecks human admin authority, binding, review, and intent inside the committing transaction.
4. Calls the existing synchronous merge endpoint with `sha=reviewedHead`, `merge_method=merge`.

The existing human-only route and transaction rechecks are retained. [publications.ts:395](../packages/code/src/publications.ts:395), [publications.ts:453](../packages/code/src/publications.ts:453)

**Safety argument and verification limit**

If current main is an ancestor of the reviewed head, the merge introduces the reviewed tree. If main advances outside that ancestry, enforced strict up-to-date checks must reject the merge. GitHub documents the up-to-date requirement; the API accepts App installation tokens and an exact head SHA, but no expected-base SHA. [Required checks documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [Merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)

That supports retaining the PR design, **conditional on live enforcement tests**. I have not verified its race behavior against a real repository here.

Release tests must use the actual App identity and rules:

- Merge an up-to-date approved head successfully.
- Advance main after inspection but before the API call; the stale merge must fail.
- Race two approved PR merges; the stale one must fail.
- Confirm strict mode is ineffective without a required check.
- Confirm adding a bypass permits the prohibited case, so the canary detects misconfiguration.
- Fetch the resulting merge commit and verify two parents and tree equality with the reviewed head.

After every successful merge, Code imports and verifies that commit. Unexpected tree/parent behavior is a publication incident, not something post-verification can retroactively prevent.

Drop the direct-push publication path. If the real-GitHub tests fail, do not enable this publication mode; revisit the primitive rather than silently weakening it.

**9. Consolidation**

Freeze all candidate acceptance IDs and commits before selecting leaves. Record `retain`, `drop`, or `adapt`; adaptation names an independently accepted replacement.

Derive the retained frontier after those decisions. Inspect its full ancestry relative to the frozen integration base.

- A dropped ancestor still carried by a retained leaf requires explicit reviewed reconciliation.
- Dropping work already on main does not remove its existing effects.
- Removing those effects requires a reviewed corrective change.
- The final review binds the candidate/decision hashes, integration base, exact head/tree, and evidence.

Use:

```text
consolidating → consolidation_review → awaiting_publication → complete
                       ↑                    |
                       └──── stale_base ────┘
```

When main changes before publication, integrate it on the same consolidation work branch and obtain a new sealed submission, review, and publication authorization. Do not mutate an approved proposal.

If main advances during the merge race but remains an ancestor of the approved head, tree equality still holds; record the actual merge parent. The PR path guarantees the reviewed tree, not an expected-base CAS.

Connected consolidation completes after the GitHub merge commit is imported and verified. Acceptance can retain the reviewed head and separately reference the verified publication commit.

Local mode publishes through a human-authorized local ref transaction with the expected old main. It requires no GitHub.

Current consolidation completes at approval while marking publication outstanding; the new state machine requires a new version. [consolidation/index.ts:815](../packages/consolidation/src/index.ts:815)

`change-spec@2` adds an explicit workspace declaration:

```ts
workspace: { provider: "none" } | { provider: "code"; version: 1 }
```

No explicit `baseTaskId` or commit appears. Research materialization passes this declaration through atomically. Version 1 keeps its historical behavior.

Both changes are necessary: the current strict schema lacks workspace, and the materializer omits it. [change-spec.ts:30](../packages/reflections/src/change-spec.ts:30), [research/index.ts:766](../packages/research/src/index.ts:766)

**10. Reconciliation, admission, and visibility**

One `Code.reconcileProject(projectId, tx)` handles base requests, plans, resolution tasks, system prerequisites, local-operation receipts, mirror work, quarantine propagation, and blockers.

Acceptance events mark projects dirty. Periodic repair invokes the same function for dirty projects and expired operations. Network/Git work runs outside database transactions and returns through fenced receipts.

DurableEvents already commits handler effects with its cursor. [domain-events/index.ts:175](../packages/domain-events/src/index.ts:175)

Session-less merge/check jobs use a generic Sessions admission capability:

- Dispatch enabled.
- Capacity and deadline.
- Project and immutable sponsoring-root budgets.
- Cancellation and complete usage reporting.
- Resource reservation before execution.
- Usage once per physical execution, including retries.

Charge the project once for shared work. Each sponsoring root sees the full shared cost for conservative root-budget enforcement. Preserve sponsorship despite later dependency changes.

Dispatch off stops new computational work. Capture, local recovery, and asynchronous mirroring are bounded drain/transport work and can continue. Checks have zero model tokens, measured resource usage, and an explicit configured cost rate.

Current admission counts worker sessions; current usage rows require a real worker session. Do not fabricate sessions for merge jobs. [dispatch.ts:1235](../packages/sessions/src/dispatch.ts:1235), [sessions/index.ts:290](../packages/sessions/src/index.ts:290)

Use `preparation_deferred` for transient Code-store availability, pending base, admission waits, or local recovery. GitHub availability is no longer a preparation dependency. These outcomes do not increment launch-failure holds; current Runner maps preparation exceptions to `workspace_failed`, which does count. [runner/index.ts:462](../packages/runner/src/index.ts:462), [dispatch.ts:130](../packages/sessions/src/dispatch.ts:130)

The stuck report and workflow read must include blocked units excluded from dispatch candidates:

```text
code_base_pending
code_merge_required
code_job_blocked
code_resolution_suspended
code_review_wait
code_capture_quarantined
code_recovery_required
code_provider_unavailable
```

Mirror problems appear as project/ref warnings and publication blockers, never ordinary unit execution blockers. Each item exposes age, last progress, next retry/deadline, related task/base/operation, and a recovery action.

Preserve quiet-session observation semantics: silence alone never revokes a writer. [sessions/index.ts:1798](../packages/sessions/src/index.ts:1798)

**11. Seven new server tables**

| Table                  | Owner     | Identity and contents                                                                                                                              |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code_projects`        | Code      | PK `project_id`; repository identity/path, mode, admitted main, binding, limits, verification warnings                                             |
| `code_units`           | Code      | PK `(project_id,unit_id)`; immutable source snapshot/base pin; write-once acceptance JSON/hash; current writer generation, lifecycle, head         |
| `code_bases`           | Code      | PK `(project_id,set_key)`; immutable members/plan; write-once result; phase/health; unique non-null resolution task                                |
| `code_operations`      | Code      | PK operation ID; unique `(project_id,principal_scope,request_id)`; immutable kind/input hash/payload; claim, local receipt, job or mirror progress |
| `code_edges`           | Code      | PK `(project_id,source_ref,relation,target_ref)`; normalized acceptance/base lineage, waiter links, and sponsorship references                     |
| `wf_blockers`          | Workflows | PK `(instance_id,provider,blocker_key)`; opaque blocker projection readable with Code absent                                                       |
| `session_service_work` | Sessions  | PK `(provider,operation_id,execution_epoch)`; reservation, deadline, measured usage and settlement                                                 |

Acceptance is a write-once section of the unit row; base result is a write-once section of the base row. Immutable operation receipts retain earlier writer generations and checkpoint history.

Reuse existing:

- `code_commands` for legacy/session commit requests.
- `code_proposals` and `code_publications`.
- Task checkpoints, task command replay, workflow history and limit grants.
- Review records and review command replay.
- Domain events for audited health/control changes.

Add nullable, versioned provenance fields to Reviews and service-owner fields to Tasks. Add dependency-kind/owner metadata to `wf_dependencies`, defaulting existing rows to `declared`. No additional rounds, acceptances, object-manifest, writer, job, ref-intent, or request tables.

Code’s current replay is session-scoped, and transport replay is tied to fixed session push identities; neither is a generic session-less journal. [commands.ts:114](../packages/code/src/commands.ts:114), [commands.ts:287](../packages/code/src/commands.ts:287), [transport.ts:190](../packages/code/src/transport.ts:190)

`code_operations` follows the same fingerprint-and-replay pattern. Owner workflow commands continue using the owner’s existing mechanism; Code does not write directly into private `wf_requests`.

All schemas have SQLite and PostgreSQL migrations, identical logical constraints, explicit insert columns, and immutable-field enforcement. Migrations are additive; no rewriting published migrations or workflow fingerprints. [state/base.ts:281](../packages/state/src/base.ts:281), [published-policies.test.ts:25](../tests/published-policies.test.ts:25)

**12. Runner split and rollout**

Keep two explicit adapters:

| Legacy                                 | New Code driver                                                  |
| -------------------------------------- | ---------------------------------------------------------------- |
| Configured local/GitHub source         | Code project endpoint and opaque workspace ref                   |
| Existing singleton private repository  | Separate cache repository per Code project                       |
| `refs/merv/central` and `codex/merv/*` | Cached exact Code checkpoints and per-unit local work refs       |
| Existing workspace/launch ledger       | Additive v2 workspace journal keyed by project, unit, generation |
| Existing receipt protocol              | Bundle upload/download and narrow finalizer                      |

The current bootstrap clones a local source, removes `origin`, and creates `refs/merv/central`; leave that intact for old versions. [workspaces.ts:1010](../packages/runner/src/workspaces.ts:1010)

For v2:

- First use initializes an empty cache and imports Code’s bundle.
- `refs/merv/central` is not consulted.
- No GitHub remote or credential exists locally.
- Local work refs are disposable caches; Code is authoritative.
- Ledger entries record generation, operation IDs, hashes, and upload progress—not credentials. Existing ledger validation already rejects credential-shaped metadata. [ledger.ts:97](../packages/runner/src/ledger.ts:97)
- `index.ts` replaces GitHub preparation/push with driver calls.
- `client.ts` adds v2 schemas/routes while preserving old command parsing.
- `profiles.ts` remains the agent harness interface; no merge/check execution is added to ordinary profiles.

Advertise `code.local.v1` for S1 and `code.bundle.v2`, `writerGeneration.v1`, `pendingMerge.v1` for S2+. Filter incompatible runners before offer.

Do not rename old refs, reset old checkouts, or reinterpret in-flight receipts. Import legacy accepted objects explicitly before allowing a v2 consumer. Preserve immutable acceptance evidence and attach the new durability proof through an operation receipt.

Code unload stops acquisitions/jobs, drains local operations/finalizers, and persists generic blockers. Mirror lag does not prevent unload. Await network operations before closing clients—the current shutdown order is reversed. [code/service.ts:124](../packages/code/src/service.ts:124)

An unresolved local writer makes graceful unload return `code_drain_pending`; explicit operator fencing can close at the last durable checkpoint. Code-less workflows remain operational.

**13. Value-first stages**

Version numbers below are proposed next versions, not edits to existing ones.

**S1 — automatic single base, local mode**

- **Versions:** `task@5`, `experiment@8`; new recipes/policies for automatic base references and acquisition pinning.
- **Tables:** `code_projects`, `code_units`, `code_edges`, `code_operations`, `wf_blockers`, in both backends.
- **Tools/routes:** existing task/experiment creation selects automatic-base versions; `code.local.bind`, `code.unit.get`, `code.status`.
- **Behavior:** operator binds today’s local repository/runner identity; accepted code is still retained under today’s local capture contract. Traverse code-less dependencies; automatically use zero/single code base. Multiple distinct commits show `code_merge_required`, without launching.
- **UI:** acceptance/submission identity, selected dependency source, pinned base, local-only durability, missing-object/multiple-base/provider blockers.
- **Tests:** both-backend populated migrations; code-less traversal; deduplication; acquisition races; exact review commit; no mutation from `references()`; Code unloaded; old `baseTaskId` behavior.
- **GitHub tests:** none; GitHub behavior is unchanged.

S1 must label acceptance storage as legacy-local. It does not claim server durability before S2.

**S2 — shared Code remote**

- **Versions:** `task@6`, `experiment@9`; v2 workspace/capture protocol.
- **Tables:** extend existing new tables with writer and repository-operation fields; additive runner-local v2 journal. No new server table.
- **Routes:** `POST /code/v2/uploads`, upload completion, bundle download, writer finalization; operator repository import/recovery; existing reads expose receipts/mirror state.
- **Behavior:** durable server captures, cross-machine resume/review, generation fencing, closure admission, asynchronous mirrors, `preparation_deferred`.
- **UI:** canonical versus mirrored head, mirror age/error, capture quarantine, recovery state, capability mismatch.
- **Tests:** kill at every Git/database boundary; duplicate/reordered finalization; stale generation; second-machine resume; secret/size/history admission; lying haves; disk full; restore; GitHub outage without launch failures; legacy runner coexistence.
- **Real GitHub:** repository token scope, work/accepted-ref pushes, rejected/ambiguous pushes, mirror recovery. Main publication remains the existing path for legacy consolidations.

**S3 — automatic merge and recovery together**

- **Versions:** `task@7` service-resolution policy; provenance-aware review contract. `task@6`/`experiment@9` gain the now-available Code capability without changing published policy definitions.
- **Tables:** `code_bases`, `session_service_work`; dependency-kind and provenance additions.
- **Tools:** `code.base.get`, base retry/suspend/resume/cancel/quarantine, service-task resume; generic service-work admission.
- **Behavior:** frozen set DAG, bounded server merges, one resolution task with rounds, system prerequisites, budgets/capacity/deadlines.
- **UI:** plan inputs, method/result, waiter graph, task/round, reviewer availability, job usage and age.
- **Tests:** every worked example; simultaneous set creation; criss-cross and rename conflicts; pending-second-parent migration; failed/abandoned/exhausted tasks; reviewer authority exclusion; dispatch off; shared-budget accounting; quarantine propagation.
- **Real GitHub:** none required for merge correctness; repeat S2 mirror tests.
- **Gate:** auto-merge stays disabled until all recovery pieces ship.

**S4 — consolidation and executable workspace declarations**

- **Versions:** `consolidation@5`, `reflection@3`, `research@5`; `change-spec@2`; new synthesis/review recipes, preserving existing recipe versions.
- **Tables:** versioned payload additions to existing consolidation/proposal/publication/review records; no new server table.
- **Tools:** existing consolidation and publication tools with frozen candidates, decision manifest, stale-base handling; research materialization accepts v2 workspace declarations.
- **UI:** candidate decisions, retained frontier, ancestry conflicts, exact reviewed tree/base, PR, enforcement warnings, publication state.
- **Tests:** dropped ancestor in retained leaf; already-on-main drop; accepted adaptation; main movement; materialization atomicity; Code absence; unchanged v1 specs.
- **Real GitHub:** strict-check/App/race matrix described above. New publication mode remains disabled until it passes.

**S5 — hardening**

- **Versions:** no workflow changes merely for storage/security implementation; `code.check.oci.v1` and new recipes only where exposed behavior changes.
- **Tables:** additive binding/storage/check metadata; avoid speculative tables until that implementation is selected.
- **Tools:** check configuration, audit verification, repository rebind, storage migration, legacy retirement.
- **UI:** sandbox availability, audit completeness, backup/storage health, migration/rebind progress.
- **Tests:** sandbox escape boundaries and termination; verified object transfer; same URL/different repository; interrupted rebind; storage migration/restore; old session drain.
- **Real GitHub:** separate Transport/Publisher identities, full auditing identity, ruleset bypass tests, rebinding verification.

Repository rebinding remains unavailable before S5; changing repository identity returns `code_rebind_required`. S5 transfers and verifies authoritative objects/refs before activating a new binding. Never adopt a replaced repository merely because its URL matches.

**14. Invariants**

1. One immutable acceptance per unit; consumers use its exact reviewed commit.
2. From S2, acknowledgment requires durable Code objects and a recoverable canonical ref receipt.
3. GitHub mirror completion is not required for handoff, acceptance, review, or successor acquisition.
4. One base per project/set; one frozen plan and at most one authoritative result.
5. Binary inputs are proper subsets with the exact required union.
6. Every actual merge commit has exactly two parents.
7. At most one resolution task exists per key; all rounds remain on it.
8. All affected present/future waiters receive its system prerequisite.
9. System prerequisites never change the code-source set.
10. One current writer generation per unit; stale generations cannot advance it.
11. A successor cannot bypass an unresolved local canonical operation.
12. **Remote mirror operations never hold the unit writer fence or prevent a successor.**
13. Review targets immutable submissions, never moving branches.
14. Contributors and their directing authorities cannot approve retained work.
15. Runners receive no GitHub credentials.
16. Main changes only through human-authorized consolidation; connected publication preserves the reviewed tree.
17. Transient preparation waits consume neither launch-failure limits nor review rounds.
18. Quarantine blocks ordinary acceptance/use/publication and propagates to dependent results.
19. Same request ID and fingerprint replays; changed input conflicts.
20. Code absence leaves code-less work operational and Code-dependent blockers readable.
21. SQLite/PostgreSQL outcomes and immutable histories remain equivalent.
22. Every unresolved operation exposes its age, reason, and permitted recovery action.

**15. Remaining owner decisions**

- **Backup recovery point:** recommend daily off-host consistent backups plus continuous asynchronous GitHub mirroring; choose a tighter schedule if losing recent acknowledged work after server-disk loss is unacceptable.
- **Initial limits:** recommend the transfer limits above, three automated resolution rounds, and five transient retries before visible infrastructure suspension.
- **Incomplete GitHub auditing:** recommend accepting the visible warning initially, while requiring the live PR enforcement tests and refusing a known bypass failure.
- **Project checks:** recommend leaving them disabled until the verified OCI adapter ships. No host-shell fallback.

**Residual risks:** The lean version concentrates object durability and Git parsing in one server deployment. A disk failure can lose work newer than the available backup/mirror, Git parser vulnerabilities share a larger failure boundary with Code, and one App/server compromise can reach publication authority. Incomplete ruleset visibility leaves reliance on owner administration and tested effective behavior; the small secret scanner misses credentials outside its patterns. These are explicit reductions in redundancy and isolation, not weakened writer fences, review independence, immutable acceptance, or base-result uniqueness.
