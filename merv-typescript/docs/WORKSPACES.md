# Runner Git workspaces

Runner prepares a private Git checkout for a frozen workflow step, preserves its final work, and reports an immutable snapshot to Sessions. A live writable worker can request a named commit through `code.commit` when its fixed tool policy permits it, then read the receipt through `code.operation`. The independent Code service queues that request; the existing Runner executes the fixed Git operation. Final WIP capture still happens after the process group stops. Neither operation publishes code to a central branch. See [Code operations](CODE_OPERATIONS.md).

## Configuration and responsibility

Start from [config/runner.git.example.json](../config/runner.git.example.json). Its machine configuration adds:

```json
{
  "workspace": {
    "repository": "/absolute/path/to/source-repository",
    "baseRef": "HEAD"
  }
}
```

The source must be an existing local repository. The CLI resolves relative repository paths against the configuration file. `baseRef` selects the initial commit when the private copy is first created; changing this configuration for an existing ledger is refused. The source credential remains in the environment variable named by `credentialEnv`.

Machine configuration supplies the repository. A workflow's immutable execution policy selects how to use it. Existing workflows that omit `workspace` continue to receive scratch directories; repository configuration alone does not change their policy.

| Component     | Responsibility                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Workflows     | Persist the versioned workspace policy and freeze named commit references with the assignment.                                  |
| Sessions      | Bind source, worker, target, policy and runner; accept the attachment and one final workspace result.                           |
| Code          | Persist commit requests, their immutable runner receipts and caller-scoped operation status.                                    |
| Runner        | Own the private repository, checkout reservation, process, fixed commit execution, local capture and retryable result delivery. |
| Native worker | Read or edit assigned files under the declared sandbox, request allowed commits and perform its allowed MCP handoff.            |

The workspace manager is an internal Runner component, not another Cordis plugin or a server State dependency.

## Workspace policies

| Mode                           | Checkout and lifetime                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`                         | One scratch directory per local launch; no Git configuration, attachment or result is needed. Scratch files are currently retained after completion.                                               |
| `ephemeral`                    | A detached checkout for that launch, from the selected commit. `retain: false` removes the checkout after capture acknowledgment.                                                                  |
| `persistent`, `perBase: false` | A branch and checkout identified by namespace, project and workflow instance. A successor resumes the previous head and retains the original base. A different explicit reference base is refused. |
| `persistent`, `perBase: true`  | Separate branch/checkouts for the namespace, project, instance and full base OID. Changing the base creates a separate lineage.                                                                    |

Git policies include `namespace`, `base` and `retain`. Persistent policies also include `perBase` and `advancesCentral`. For example, a writable step can declare this `workspace` field inside its execution policy:

```json
{
  "mode": "persistent",
  "namespace": "code",
  "base": "central",
  "perBase": false,
  "retain": true,
  "advancesCentral": false
}
```

`readOnly` belongs to the enclosing execution policy. A verifier can use an ephemeral checkout with `base: "reference:code"` and `readOnly: true`, provided `execution.references.code` contains the frozen commit OID.

There are two base forms:

- `central` resolves the **machine's private** `refs/merv/central`, initialized once from the configured `baseRef`. It is not a server-authoritative project head and does not follow subsequent source-branch changes.
- `reference:name` requires a frozen scalar reference containing a full lowercase 40- or 64-character Git commit OID already available in the private repository. Missing, list-valued, abbreviated or unavailable references fail. There is no implicit fallback to `central`.

`advancesCentral` is retained in the versioned declaration but causes no publication in this implementation. Even `true` supplies no central-update authority or receipt. Programs must not treat captured code as published code.

The source is cloned once into a private bare repository without local hardlinks, alternates, or a retained source remote. The original repository is not changed. No fetch or network clone runs. The configured local source must remain available for current manager validation; importing newer source commits and transferring objects between machines remain open work.

Persistent branches start with `codex/merv/`. Shared persistent, per-base persistent and ephemeral checkouts occupy separate directory roots, so valid policy changes cannot nest one checkout inside another. Git-unsafe namespace components are encoded without collisions; full base OIDs distinguish per-base lineages.

## Ownership, capture and cleanup

The local launch ledger and workspace tables use the same private SQLite database. Repository identity, checkout reservation and prepare intent are durable before Git creates a checkout. A persistent slot belongs to one exact launch until capture and cleanup finish. A successor cannot reuse an active, uncertain or unacknowledged checkout.

```mermaid
flowchart LR
  P[Persist checkout intent] --> C[Prepare owned checkout]
  C --> A[Attach launch and snapshot]
  A --> W[Worker edits files]
  W --> Q[Allowed code.commit request]
  Q --> M[Runner commits and reports receipt]
  M --> W
  W --> S[Confirm process-group stop]
  S --> G[Capture locally]
  G --> R[Report immutable result]
  R --> K[Acknowledge and clean up]
```

Attach rechecks current session admission before spawn and does not activate the workflow. The first authenticated worker MCP operation activates it. Runner uses its stable launch ID as `hostRef`; retries or another runner cannot replace that attachment.

## Commits while the worker is alive

`code.commit` accepts an expected full HEAD OID, a message and a replayable request ID. Code checks current session authority and the fixed tool declaration before queueing the command. Runner claims commands with the original source credential, confirms the live local process and exact checkout ownership, and refuses read-only, expired or replaced workers. A Git workspace declaration alone does not grant this tool.

The local command journal precedes Git writes. A private per-attempt index freezes the tree; parent, message and timestamp determine the same commit object on retry. Updating the owned HEAD and recording the receipt ref happen in one Git ref transaction guarded by the current launch/epoch owner ref. The original source repository and private central ref remain unchanged. The normal checkout index is synchronized without resetting later working-file edits.

Capture permanently replaces the owner ref with a closed marker before final HEAD work. Delayed commit or initial ownership transactions cannot regain access after closure or successor acquisition. Applied receipts can still be recovered and reported after the process stops. An ambiguous Git outcome remains pending until a receipt proves success or the closed fence proves the command did not apply. A lost server dispatch reply is recovered even if the worker closes before the runner journals it. Command and final-capture acknowledgments both precede checkout release.

A commit receipt identifies this operation's parent, tree, head, repository, workspace, base and statistics. It is separate from the final Session workspace result: later worker edits or stopped-worker WIP capture do not change it. The server retains authenticated observations; it does not independently inspect the Git objects.

## Final capture

Capture requires locally confirmed termination. Server-side lease closure alone is insufficient. Writable capture stages Git changes and creates a WIP commit when needed, with a fixed Runner author and the session ID in its message. Changed files larger than 50 MiB are refused before that commit; unchanged historical large files do not block new small changes. This is a per-file bound, not an aggregate repository limit. Git-ignored outputs are not automatically included.

Read-only capture never creates a commit. A changed HEAD, dirty index or dirty worktree is refused and preserved for investigation. Checkout identity, expected branch and private Git administration paths are checked on preparation/resume and capture. Unsafe private Git configuration, symlinked ownership paths and foreign checkouts fail closed. Normal tracked file symlinks remain Git data.

The final local snapshot is durable before reporting. A lost reply retries the same result rather than recapturing a later branch head. Each launch retains its own final snapshot even after a persistent successor adds commits. Statistics describe changes from the retained base to that head; they can include earlier work on a persistent branch.

After server acknowledgment, `retain: false` removes the checkout. Persistent branches, Git objects, launch history and captured metadata remain; a later persistent lease can recreate its checkout at the retained head. `retain: true` keeps the checkout too. Failed reporting keeps the reservation occupied, preventing a successor from overwriting work while receipt delivery remains unresolved.

## Restart and failure behavior

A replacement controller reconnects to the existing process guardian and replays matching preparation without resetting files. If Git created a valid owned checkout but the ready-state commit was interrupted, the manager validates and resumes it. Unverified partial checkouts are preserved rather than adopted, pruned or deleted. An unstarted terminal launch can cancel that preparation and release its remote lease; using that lineage again may require manual investigation.

Runner captures a confirmed finished process before fetching fresh server state. A network outage or source refusal therefore does not discard local WIP. Reporting still requires the original authenticated source authority. Source-key revocation, changed membership or a prolonged outage can leave a retained result awaiting authorized reconciliation; this slice adds no credential-rotation bypass.

A lost attach reply remains ambiguous. Runner closes the remote lease before deciding that no attachment exists, preventing a delayed attach from racing with local checkout release. It can then report the exact attached result even for a closed session. Closing or reporting never reactivates the worker.

An unreachable guardian leaves the launch `uncertain`; its checkout and local capacity stay reserved. No saved PID or remote lifecycle state proves that a process tree stopped. See the [process ownership contract](../packages/runner/README.md).

## Server result contract and trust boundary

Source-authenticated `POST /sessions/:id/attach` carries `runnerId`, `hostRef` and the Git workspace attachment. After capture, `POST /sessions/:id/workspace-result` carries the same runner/host identity and the final workspace object. Session workers cannot use these source-control routes.

Both snapshots contain:

```ts
interface SessionWorkspace {
  repositoryId: string;
  workspaceId: string;
  mode: 'ephemeral' | 'persistent';
  branch: string | null;
  baseOid: string;
  headOid: string;
  stats: {
    commitCount: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}
```

Sessions exposes `workspace: { attachment, result }`, with `result: null` until reporting. Identity, mode, branch and base must match the attachment. A read-only result must retain the attached head. An identical final-result replay succeeds; a different result conflicts. The result and its `session.workspace_result` event commit together with source, worker, workflow version, state, revision and policy provenance. Late results remain per-session facts and do not overwrite a global instance pointer.

These are **source-authenticated Runner observations**. The server validates authority, schema, identity and replay consistency; it does not fetch Git objects, independently calculate the diff, or prove ancestry. The receipt acknowledges capture; it does not authorize approval or publication.

## Current limits and validation

Native support consists of sandboxed file editing/read-only inspection, policy-granted commit requests through Code, and host-side Runner WIP capture. The worker is not granted arbitrary private Git metadata writes, merge commands or ref updates. The `command` profile is a trusted executable without an equivalent verified sandbox and refuses read-only leases. Private files and process groups do not isolate hostile programs sharing one OS user.

There is no `code.propose`, central publication, reviewed-proposal binding, compare-and-swap advance receipt, general merge/ancestry verification, remote Git push/fetch, cross-machine object transport, automatic retention pruning, or general repair of uncertain workspaces. Ordinary task workflows still need explicit Git policies, tool grants and domain-owned code-reference production. Python's full consolidation/publication flow remains a separate integration step.

The historical workspace-capture checkpoint passed all **490 repository tests**, including 12 focused local Git workspace tests and synthetic HTTP/MCP workspace integration. Backend and UI typechecks/builds passed. This count predates Code operations; later integrated checks are recorded separately.

Native acceptance also passed on 2026-09-15: `scripts/live-runner-workspace.ts` launched exactly two fresh Codex agents through a synthetic managed workflow, `work → capture → verify → done`. The writer edited its sandboxed file, Runner captured the commit, and the read-only verifier inspected that exact frozen commit. The source repository stayed unchanged; both process groups stopped and both workspace records closed. The local report is `/private/tmp/merv-native-git-live-20260915-02/report.json`.

This proves the native file-edit/capture/verification path on one machine with one private object store. It does not exercise the actual Reviews plugin, research consolidation, central publication or cross-machine object transfer.

The Code foundation separately passed 20 local Git tests and two synthetic HTTP/MCP integration tests, covering deterministic crash recovery, delayed ownership/ref transactions, live-worker receipts, actual Reviews attribution and lost dispatch/acknowledgment recovery. Those tests use synthetic executable workers. The historical native capture run above is not evidence for the new native Code path; see [Code verification](CODE_OPERATIONS.md) for its own acceptance status.

Run `npm run test:runner` for the Runner suite, or `node --import tsx --test tests/runner-workspaces.test.ts` for local Git lifecycle tests. Native acceptance launches real agents and is a separate, explicit operation.
