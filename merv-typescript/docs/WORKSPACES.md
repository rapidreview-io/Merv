# Runner Git workspaces

Current tasks and experiments use Code's native Git remote through the `code.git.1` driver. Workers run ordinary Git in their assigned checkouts. Merv creates commits for approved milestones and, when needed, planned VM shutdown capture; it does not make timer or ordinary session-end commits. See [Code operations](CODE_OPERATIONS.md) for transport, admission and authentication.

## Ownership

| Component     | Responsibility                                                                             |
| ------------- | ------------------------------------------------------------------------------------------ |
| Workflows     | Freeze the versioned execution policy and named references.                                |
| Sessions      | Bind source, worker, runner and host; validate attachments, results and shutdown receipts. |
| Code          | Serve Git, enforce grants and writer generations, validate objects and retain refs.        |
| Code Work     | Freeze submission identity, verify review provenance and journal approved milestones.      |
| Runner        | Own processes, checkout preparation and retryable stopped-process capture.                 |
| Native worker | Edit the assigned checkout, use Git and perform the allowed workflow handoff.              |

Current policies require the native driver capability. Old `code.v2` policies remain readable with their published definitions unchanged; unfinished legacy work and old runners must drain before cutover. New runtimes refuse legacy writable leases with `code_legacy_drain_required`. The read-only deployment preflight checks this drain. An old image alone is not a supported rollback after cutover.

## Work and review

Code Work's `codeWorkspace()` declares two shapes, each with the owner's namespace:

| Purpose | Policy                                                         | Use                                                                               |
| ------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Work    | Persistent, retained, `reference:base`, `code.git.1`           | Task producers; experiment planners and executors; customer experiment executors. |
| Review  | Ephemeral, `reference:code`, `code.git.1`, read-only execution | Independent task, design and results review.                                      |

A work unit has one pinned dependency base and one assigned branch. A continuing session on the same work host preserves its working files, including uncommitted changes. Another host can recover durable Git history; unexpected loss of a host can lose untransferred files. Planned teardown or repurpose waits for verified shutdown capture first.

The first producing lease derives the base from dependencies' exact durable accepted references. Several dependencies can require a shared merge plan and an independently reviewed resolution task. Missing acceptance or unresolved bases block lease admission. Reading an assignment neither pins nor changes its base. Reference OIDs must be full lowercase 40- or 64-character values.

Reviewers receive the immutable submission's parent commit plus its exact frozen tree, including submitted uncommitted changes. HEAD identifies the parent; it is not a preapproval commit. The checkout and Git metadata are mounted read-only, with separate writable scratch space. The reviewer cannot access the producer's writable checkout or writer credentials. An execution environment unable to enforce this isolation refuses review work.

## Submission and approval

1. The actual producing session submits through its workflow. Code Work records the request and provenance in the handoff transaction.
2. Runner confirms the producer process group has stopped, writes the exact Git tree, and pushes retained tree and parent refs with its narrow capture grant. No commit is created by submission.
3. Code Work verifies the retained objects, current parent and writer generation, then seals the submission receipt. Review dispatch waits for this receipt.
4. The independent reviewer inspects that frozen checkout. A passing verdict journals its milestone in the same transaction as the approval.
5. Reconciliation materializes the exact approved tree and parent once, or reuses an already matching verified result. An unchanged tree needs no new commit. The next writer and accepted-code dependents wait until the durable result is recorded.

Rejected submissions remain immutable evidence. A returned producer continues with its retained work and a new session; it cannot replace the earlier submission. Lost replies retry the same receipt and approval identity. Approval reconciliation completes an authorized milestone; it does not perform periodic WIP capture.

## Ordinary end and planned shutdown

Ordinary session end pushes any agent-created commits, closes the writer generation and reports metadata. It leaves dirty files on the retained work host without creating a commit. A read-only session reports its exact attachment.

Before planned VM removal, Fleet requests shutdown. The supervisor stops producers, settles requested submissions, then captures remaining writer files if their tree needs a commit. It pushes and verifies the result and reports the exact session, unit, head, tree and operation. Sessions validates that receipt before Fleet may release the host. Outages or lost replies keep shutdown pending. Cleanup credentials authorize only this owned historical work, not new leases or ordinary writes.

## Restart and result boundary

Checkout intent is durable before preparation, and the stable launch ID is attached before spawn. A controller reconnects to the existing process guardian after restart. Matching retries preserve files; foreign or partial paths are kept for recovery rather than silently adopted or deleted. An unreachable guardian leaves local capacity reserved until the process is proven gone.

Capture requires locally confirmed termination. Server-side lease closure alone is insufficient. A successor cannot take the checkout until the previous launch has finished result reporting and cleanup. Source revocation or a prolonged outage can leave local work awaiting authorized reconciliation; this creates no credential-rotation bypass.

Source-authenticated attachment and result requests carry the exact runner and host identity. Session snapshots include repository/workspace IDs, mode, branch, base and head OIDs, optional tree OID, statistics and, for a frozen submission, `{ sessionId, parentOid, treeOid }`. Writer identity and base stay fixed; a read-only result must equal its full attached snapshot. An identical final result replay succeeds, while a different result conflicts. Late results never reactivate the worker.

Session results are authenticated machine observations. Code separately verifies admitted Git objects, and Code Work separately verifies submission and review authority. A result by itself does not approve code or authorize movement of managed main.

## Validation

`npm run test:runner` covers runner process and recovery behavior. Native Git HTTP, submission, approval and shutdown tests exercise real Git and PostgreSQL. Hosted review isolation additionally requires the Linux image gates in [hosted runner operations](../scripts/hosted-runner/README.md); a trusted local `command` profile cannot provide that isolation. Production acceptance remains an explicit deployment operation.
