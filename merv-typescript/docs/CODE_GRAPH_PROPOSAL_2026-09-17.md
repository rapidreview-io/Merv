# Code as a GitHub-style graph: study and proposal (2026-09-17)

Read-only study commissioned after the founder ruled "Code needs to be visualized differently, use GitHub's own diagrams or something." Nothing here changed code; the sketch is on the design canvas.

---

# Code, visualised as a branch graph

Read-only design study, 2026-09-17. The founder's ruling on `docs/PLUGIN_UI_MAP.md`: _"Code must be visualised differently, GitHub's own diagrams or the like."_

Merv already records everything a branch graph needs. It renders none of it. Today's `/code` page is six columns of truncated identifiers — command id, instance id, actor id, manifest artifact id, two hashes — and its own component's comment admits it: `ObjId` exists in `packages/ui/web/components.tsx` "for [views/code.tsx and views/settings.tsx] alone until their own pass removes it." This is that pass.

The proposal is: **stop listing code operations and draw them.** One lane per branch, one dot per checkpoint, the diffstat over each dot, a ring on the trunk where a reviewed proposal merged. Borrow GitHub's shapes where they already carry meaning, translate them into the contract's idiom, and link out to GitHub for everything GitHub renders better than we ever will.

Sketch: [`Code.dc.html`](./Code.dc.html) (1440 wide, self-contained; `Code.dc.png` is the render). References: [`refs/`](./refs).

---

## 0. References, and what each one contributed

| Reference                                                      | What it settled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refs/github-commits.png` — `github.com/cli/cli/commits/trunk` | The time axis. GitHub groups commits under a date heading marked by a small node glyph on a vertical hairline, and each row carries message, author, a checks summary (`✓ 8/8`) and the short SHA as the only mono text. Merv's version: faint date ticks over the graph, and the short SHA only in Details.                                                                                                                                                                                                                                                                                                  |
| `refs/github-pr-merged.png` — `github.com/cli/cli/pull/14461`  | The whole PR grammar in one screen: the `Merged` StateLabel; `williammartin merged 1 commit into [trunk] from [bump-go-gh]` with two BranchName pills; the tab strip carrying `Checks 53` and `Files changed 2`; the diffstat `+3 −3` with its green/red squares pinned to the right of the strip; the Timeline running down the page with a badge per event (commit, review requested, approved, merged, branch deleted). **This screen is the model for the pull-request row.**                                                                                                                             |
| `refs/github-pr-files.png`                                     | Why not to rebuild the diff. Split/unified toggle, per-file collapse, blame, line comments, suggestions, viewed-state — none of it is worth reimplementing. Link out.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `refs/primer-timeline.png` + primer.style/components/timeline  | _"The Timeline component is used to display items on a vertical Timeline, connected by Timeline elements."_ Anatomy: `Timeline.Item`, `.Badge`, `.Body`, `.Break`; a connecting rail through the badges; `clipSidebar` controls whether the rail runs past the first and last item; a `condensed` variant drops the badge background. Merv already has this shape (`RoundsSpine`); the graph is its horizontal sibling.                                                                                                                                                                                       |
| `refs/primer-state-label.png` + docs                           | _"StateLabel is used for rendering the status of an issue or pull request."_ The exact PR vocabulary: **Draft, Open, Merged, Closed, Unavailable** (issues add "Closed (not planned)"). _"Each status variant has an associated icon."_ Colours: grey / green / purple / red / grey. Merv takes the **vocabulary**, not the filled pill or the icon.                                                                                                                                                                                                                                                          |
| `refs/primer-branch-name.png` + docs                           | _"BranchName is a label-type component rendered as an `<a>` tag by default that displays the name of a branch."_ Use it _"in places where users can't easily determine whether the label represents a branch from the surrounding context."_ That is exactly our case.                                                                                                                                                                                                                                                                                                                                        |
| `refs/primer-label.png` + docs                                 | Label is _"a piece of text that is visually stylized to differentiate it as contextual metadata."_ Ten variants. Merv already has this as `.kind` and `.status` — nothing to borrow, and a reason not to add a third pill family.                                                                                                                                                                                                                                                                                                                                                                             |
| GitHub docs, "Understanding connections between repositories"  | The network graph _"displays the branch history of the entire repository network, including fork branches"_; _"the first row references the date and the first column references the branch owner"_; it _"shows up to 100 of the most recently pushed-to branches."_ The page itself says: _"Timeline of the most recent commits to this repository and its network ordered by most recently pushed to and updated daily."_ **The label column on the left, the time axis across the top, one lane per owner** — that is the layout Merv copies, with "owner" replaced by "the record that owns this branch". |
| GitHub Blog, "Say hello to the Network Graph Visualizer"       | _"On the left hand side is a list of GitHub users. Across from each user is drawn a graph of commits."_ And the invariant that makes the picture readable: _"you are seeing every commit on every branch of every repository that belongs to a network. But you are seeing each commit only once."_ Merv's equivalent: a commit is drawn on the lane that produced it and nowhere else; a proposal that pins an experiment's head is its own lane starting at that dot, not a redraw of it.                                                                                                                   |
| GitHub docs, "About pull request merges"                       | _"A merge commit preserves the full commit history from the pull request branch"_ and _"creates an explicit merge point in the base branch history."_ This is why `publications.ts` hard-codes `'merge'` and why the ring on the trunk is honest: reviewed ancestry really is in main.                                                                                                                                                                                                                                                                                                                        |
| GitHub docs, "About status checks"                             | _"Status checks show whether commits meet the conditions set for a repository."_ Statuses `queued / requested / in_progress / completed`; conclusions `success / failure / neutral / skipped`. Note: _"A job that is skipped will report its status as 'Success'."_ Merv's `toneOf` already maps all of these words.                                                                                                                                                                                                                                                                                          |

**One capture failed.** `github.com/<repo>/network` renders its graph client-side and returns GitHub's 500 page to a logged-out headless browser after a couple of hits; three attempts across two repositories gave the unicorn. The page's own description text and the docs above carry the definition, and the commits page supplies the timeline shape, so nothing in this proposal rests on the missing screenshot. `github_shot.mjs` and `net_shot.mjs` beside this file reproduce the run.

---

## 1. The data Merv already has, mapped to GitHub's objects

Everything below exists today unless marked. Paths are under `merv-typescript/`.

### Repository ← the GitHub connection

`GitHubStatus` (`packages/contracts/src/github-models.ts:14`), read by `GET /code/github`:
`configured, revision, status ('disconnected' | 'connected' | 'needs_reconnect' | 'refreshing'), user{id,login}, repository{id, installationId, fullName, url, defaultBranch, private}, canManage, canBrowse, installUrl, automationConfigured, automation ('off'|'read'|'write'), baseBranch`.

One connection per project (`code_github` is keyed by `project_id`). `automation` and `baseBranch` are the human's explicit choice, and the base branch is **the trunk**.

### Base branch ← `GitHubStatus.baseBranch`

`GET /code/github/branches` returns `GitHubBranch{name, sha, protected}` for the chooser. The head sha is available; **the trunk's own commit history is not** — see §5, blocked.

### Branch (a lane) ← an experiment's persistent Git workspace

`SessionWorkspace` (`packages/contracts/src/workspace.ts`): `repositoryId, workspaceId, mode ('ephemeral'|'persistent'), branch, baseOid, headOid, treeOid?, stats{commitCount, filesChanged, insertions, deletions}`.

`packages/experiments/src/program.ts:759-779` gives an experiment in state `running` a `persistent` workspace (`namespace: 'experiments'`, `base: 'central'`, `perBase: false`, `retain: true`), and in `experiment_review` an `ephemeral` one pinned to `reference:code`. The runner derives the ref (`packages/runner/src/workspaces.ts:273`):

```
codex/merv/shared/<namespace>/<projectId>/<instanceId>
```

An ephemeral review workspace has `branch: null`. **Persistent experiment workspaces are lanes; ephemeral review workspaces are not** — they are a read of a pinned commit, and drawing them would invent a branch that has no ref.

`instanceId` is the experiment's own id: `packages/experiments/src/program.ts:444` asserts `p.instanceId === experiment.id`. That equality is the join from a commit to a lane label. The experiment record already carries `workspace?: 'git'` (`packages/experiments/src/models.ts:109`), so a lane is omitted where there is none rather than drawn empty.

### Commit (a dot) ← a `code.commit` receipt

`CodeCommandRecord` (`packages/contracts/src/code.ts:35`), read by `code.list`:

- `command{ id, projectId, sessionId, actorId, instanceId, expectedRevision, runnerId, hostRef, workspace, expectedHead, message, createdAt }`
- `status: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'cancelled'`
- `receipt{ commandId, repositoryId, workspaceId, baseOid, parentOid, headOid, treeOid, stats{commitCount, filesChanged, insertions, deletions} } | null`
- `error: string | null`

So a dot has: its position on the lane (`createdAt`), its parent (`parentOid`, invariantly `=== command.expectedHead`), the lane's root (`baseOid`), its own identity (`headOid`), its message, and **the diffstat** — `stats.insertions` and `stats.deletions`, which exist today and are rendered nowhere. `code.tsx` prints only `filesChanged`.

A `failed` or `cancelled` command has no receipt. It is not a dot; at most it is a lane annotation ("one checkpoint could not be recorded"), and the honest default is to leave it out of the drawing entirely and let the error surface on the session.

### Pull-request candidate ← a sealed `CodeProposal`

`packages/code/src/types.ts:34`, read by `code.proposals(caller, instanceId?)`:
`id, projectId, instanceId, revision, createdAt, producer{actorId, sessionId, source}, workflow{name, version, state, revision, policyHash, registrationId}, command, receipt, summary, artifacts[], pinnedInputIds[], provenance, admission, manifestHash, manifestArtifact`.

A proposal is immutable (SQLite triggers refuse update and delete), pins one exact commit (`receipt.headOid`), carries a canonical manifest whose hash is the SHA-256 of its actual bytes, and numbers itself `revision` 1..n within its workflow instance. `summary` is the human-readable name — **this is the lane label; the proposal id never appears.**

### Pull request ← a `CodePublication` plus GitHub's own record

`CodePublication` (`packages/contracts/src/code-publication-models.ts`), read by `GET /code/publications`:
`proposalId, instanceId, manifestHash, repository, repositoryId, connectionRevision, branch ('merv/proposals/<proposalId>'), baseBranch, baseOid, headOid, treeOid, title, createdAt, review{id, actorId, verdict: 'pass'|'needs_changes'|'fail', recordedAt} | null, pull | null, merge{requestId, actorId, expectedBase, requestedAt, commitSha} | null, lastError`.

`GitHubPullRequest`: `id, number, nodeId, url, title, body, state ('open'|'closed'), draft, head{ref,sha,repositoryId}, base{ref,sha,repositoryId}, merged, mergeCommitSha, mergeable, mergeState, updatedAt`.

`GET /code/publications/<proposalId>` adds `GitHubPullDetails`: `files[{path, previousPath, status, additions, deletions, patch}]`, `commits[{sha, tree, parents, message, url}]`, `checks[{name, status, conclusion, url}]`, `reviews[{id, user, state, commitSha, body, submittedAt}]`, `commitStatus ('pending'|'success'|'failure')`, `statusCount`.

The publication's own state word is already derived in `views/github-publications.tsx`: `blocked → merged → returned → closed → ready → draft → pending`. That is Merv's StateLabel, and it is strictly richer than GitHub's five because it also says where Merv's own verdict stands.

### Summary table

| GitHub object       | Merv record                                                       | Where it is read              | Exists today              |
| ------------------- | ----------------------------------------------------------------- | ----------------------------- | ------------------------- |
| Repository          | GitHub connection                                                 | `GET /code/github`            | yes                       |
| Trunk               | `baseBranch` + `GET /code/github/branches` head sha               | github.ts                     | head only                 |
| Trunk's commits     | —                                                                 | —                             | **no** (see §5)           |
| Branch / lane       | persistent `SessionWorkspace.branch` on each command              | `code.list`                   | yes                       |
| Lane label          | the experiment's `name`, joined by `instanceId === experiment.id` | `experiment.list`             | yes, **not joined today** |
| Commit / dot        | `receipt.headOid`, `parentOid`, `baseOid`                         | `code.list`                   | yes                       |
| Diffstat `+n −m`    | `receipt.stats.insertions` / `.deletions`                         | `code.list`                   | yes, **never rendered**   |
| Files changed       | `receipt.stats.filesChanged`                                      | `code.list`                   | yes                       |
| PR candidate        | `CodeProposal` (pinned commit, manifest, revision)                | `code.proposals`              | yes                       |
| Pull request        | `CodePublication.pull`                                            | `GET /code/publications`      | yes                       |
| Merge marker        | `publication.merge.commitSha` / `pull.mergeCommitSha`             | same                          | yes                       |
| StateLabel          | `status(p)` in github-publications.tsx                            | browser-derived               | yes                       |
| Checks              | `GitHubPullDetails.checks` + `commitStatus` / `statusCount`       | `GET /code/publications/<id>` | yes                       |
| Independent verdict | `publication.review.verdict`                                      | same                          | yes                       |

**What Codex's plan adds:** all six implementation steps of `docs/GITHUB_PUBLICATION_PLAN.md` have landed. `docs/GITHUB_PUBLICATION_READINESS.md` records live acceptance on 2026-09-17 against smoke PR #3, including the API-version fix pinning REST to `2022-11-28` so `merge_commit_sha` survives, and the deploy `20260917T054918Z-72171e36`. So the data this visual model needs is **already in production**. What the plan does not add, and what stays out of scope here, is a repository-commits read for the trunk, and any join from a code operation to the record that produced it.

---

## 2. The visual model

### The shape

A **branch graph**, laid out exactly as GitHub's network graph is described: _"the first row references the date and the first column references the branch owner."_

- **Left column (≈360px):** the lane's owner, which in Merv is a _record_, not a person. Kind label in its colour (`EXPERIMENT` teal `#0d9488`, `PROPOSAL` amber `#d97706`), the record's name at 14/600 ink, then one meta line: the state dot and word, and the checkpoint count.
- **Top:** date ticks. 11px faint, 0.06em tracked, a 8px hairline tick each. The time axis is the only scale on the drawing; there is no axis line, no grid.
- **Trunk:** a 1.5px hairline for the base branch, with a mono BranchName pill as its label. Dots only where Merv can name the commit — the oid each lane was cut from, and each merge commit. Past the last known point the trunk continues as a 2/4 dash: **main has history we did not read, and the drawing says so instead of inventing it.**
- **Lanes:** a 1px hairline per branch, leaving the trunk at its `baseOid` with a 24px rounded elbow. Lanes are ordered so a proposal sits directly under the experiment it was cut from. Lines cross where lanes were cut at different times; a crossing is never a junction, and no dot is ever placed on one.
- **Dots:** 4px, ground-filled with a 1.5px hairline stroke. The branch's current head is filled ink at 4.5px. One commit is drawn once, on the lane that produced it — the network graph's own invariant.
- **The diffstat, borrowed verbatim:** `+n −m` centred above each dot, 11px, tabular, additions `--supports` and deletions `--refutes`. This is the one place in Merv where a pair of numbers is the entire content of a label, and GitHub's form for it is already the best one.
- **The merge marker:** a ring at r=9 around the trunk dot. A ring, not a colour and not an icon — kind colours live in labels only, and icons live only in the rail.

### What is borrowed, and how it is translated

| GitHub element                 | Kept because                                                                                                                   | Rendered in Merv as                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BranchName pill**            | Primer's own reason applies literally: _"in places where users can't easily determine whether the label represents a branch."_ | A hairline pill, radius 999. It is the one box the graph draws, and it is drawn because **the box is the object** — the pill is what says "this text names a branch." **Naming rule:** a ref a person chose is printed as itself, in mono (`main`); a ref _Merv generated_ is named by the record it belongs to, in sans (`Stain normalisation, promoted from attempt 2`). This is what keeps `codex/merv/shared/experiments/<projectId>/<instanceId>` and `merv/proposals/codeprop_…` off the page — both embed identifiers, which the 2026-09-17 ruling forbids. The literal ref survives as machine text in Details and in the pill's `title`. |
| **StateLabel vocabulary**      | Draft / Open / Merged / Closed is the standard vocabulary for this object, and people arrive already knowing it.               | Merv's state dot plus the small-caps word (`.status` + `.status-dot`), not Primer's filled pill: _"Each status variant has an associated icon"_ and the founder's ruling is that the rail's glyphs are the only icons. Merv's seven-word set (`pending, draft, ready, merged, returned, closed, blocked`) is kept, because it also reports where **Merv's** verdict stands, which GitHub cannot know. `toneOf` already colours all seven.                                                                                                                                                                                                         |
| **Diffstat `+n −m`**           | Nothing is better, and the data is already in the receipt.                                                                     | Verbatim, in `--supports` / `--refutes`, tabular. GitHub's little green/red squares are dropped — they are a fifth encoding of the same number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **PR merge-box states**        | A merge is the one irreversible human act in this whole path, and it must state its consequence.                               | The existing confirmation guard in `github-publications.tsx` stays exactly as it is: a **box, because the box is the object** — a guard naming what it is about to change. Its sentence already does the contract's job ("Merge `f22a9901` into **main** using a merge commit? … GitHub does not offer an atomic base lock."). `mergeState` and base drift become one muted sentence, not a rebuilt merge box.                                                                                                                                                                                                                                    |
| **Checks list**                | The list is the content; the conclusion word is the state.                                                                     | A hairline two-column list: check name (linked to GitHub) and its conclusion as a state dot and word. `commitStatus`/`statusCount` fold in as one more row ("2 commit statuses"). Conclusions map through the existing `toneOf`: `success → ok`, `failure → bad`, `neutral`/`skipped` → `dim`, `queued`/`in_progress` → `warn`.                                                                                                                                                                                                                                                                                                                   |
| **Primer Timeline**            | _"items on a vertical Timeline, connected by Timeline elements"_ — Merv already draws exactly this as `RoundsSpine`.           | Nothing new. The **graph is its horizontal sibling**, and the publication's own history (sealed → PR opened → verdict → out of draft → merged) is a Timeline that `RoundsSpine` can already render. No second spine component.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Commits-page date grouping** | A time axis that costs nothing.                                                                                                | Faint date ticks above the graph.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### What links out rather than being rebuilt

Every one of these is a place where GitHub is better and always will be. The row ends with one link, `Open pull request on GitHub →`, and a faint line saying what lives there.

1. **The diff.** `github-publications.tsx` today renders every `f.patch` into a `<pre>` with a 32rem max-height. GitHub has split/unified, blame, per-line comments, suggestions, viewed-state and expandable context. Delete ours.
2. **The conversation** and GitHub's own reviews. Merv's independent verdict is the one that gates the merge; GitHub's reviews are informational. One line ("3 GitHub reviews"), then the link.
3. **The commit list inside a PR.** The graph already shows the pinned commit; the rest is one click away.
4. **Branch protection and conflict explanations.** Surface `mergeState` as a sentence; GitHub explains it.
5. **The fork network.** Merv's graph is this repository's Merv-made branches against one base. It is not GitHub's network graph and should not pretend to be.

### What the graph must never do

- Never draw a relation no field expresses. The map's rule applies here: _"a relation no field expresses is omitted, not invented."_ There is no field saying experiment B built on experiment A, so no edge between lanes.
- Never draw trunk history it did not read (hence the dashed continuation).
- Never draw check state on a lane dot. Checks exist only on a PR head; a checkpoint has none.
- No canvas, no graph library, nothing draggable, no minimap. The contract's carve-out for the one drawn graph allows a legend and nothing more; this is plain SVG placed from a date scale, the same discipline `views/map.tsx` uses ("The graph places itself from one measured width, so it needs no canvas and no library").

---

## 3. Where it lives after the rail cleanup

The rail becomes Home · Now · Research (Claims, Paper, Files) · Work (Work, Reflections) · Agents (Sessions, Sandboxes) · Feed · Settings (Introduction, Members, Keys, Connections, Integrations, Plugins, Session). **Code is not a row.** Three homes, one read each.

### a. The experiment record's History — one lane, that experiment's branch

`RecordPage` already has the slot, and `history` already holds "how it got here" (`RoundsSpine`, `ProcessTrack`). The lane goes beneath them, because the code is how the attempt got where it got.

- **Renders when** `experiment.workspace === 'git'`. Otherwise the block is not written, per the anatomy's rule ("a slot this kind has nothing for is dropped rather than drawn empty").
- **Reads:** `code.list`, filtered client-side to `command.instanceId === experiment.id`; plus `code.proposals(caller, instanceId)` if a proposal was sealed from it. Both already exist; `code.proposals` already takes an `instanceId`, it is simply not exposed through the row's `read`.
- **Shows:** the trunk stub with its base oid, the lane, its dots with diffstats, and — if a proposal was sealed — its dot and, if merged, the ring.

This is the smallest and most valuable of the three, and the one to build first.

### b. Settings › Integrations › GitHub — the whole-repository graph

A tile on the Integrations index (repository full name, connection status, base branch — the shape the map's Integrations plane already uses), and a page holding, in order:

1. `<GitHubConnection/>` — `views/github.tsx`, unchanged, Codex's.
2. `<GitHubAutomation/>` — `views/github-automation.tsx`, unchanged, Codex's, already nested inside the connection.
3. **The branch graph**, every lane in the project.
4. **The pull-request list**, the trimmed `<GitHubPublications/>`.

- **Reads:** `GET /code/github` (status), `code.list` + `code.proposals` (the row's `ui.read`), `GET /code/publications` (the list), `GET /code/publications/<proposalId>` on open, `GET /code/github/branches` only when the base-branch chooser is opened.
- The map's Integrations tile retargets from `codeRow.path` to this route — one expression in `views/map.tsx:484`.

This is exactly the sketch in `Code.dc.html`.

### c. The consolidation phase's Act and Related — the pull request

Per the 2026-09-17 rail ruling, consolidation is the final phase of a reflection wave, created from the approved reflection's Act. So the reflection record, in its consolidation phase:

- **Act** holds the merge control, under precisely Codex's existing guard: signed-in operator, `review.verdict === 'pass'`, `pull.state === 'open'`, `!pull.draft`. The confirmation guard is unchanged. Everything else on the page is read-only.
- **Related** holds the pull-request row: state word, the two branch pills, the diffstat, the checks list, the independent verdict line, and `Open pull request on GitHub →`.
- **Details** holds the machine text: reviewed head, base at merge, merge commit, manifest hash, the literal published branch.
- **Reads:** `GET /code/publications` for the row, `GET /code/publications/<proposalId>` for checks on open.

### d. Now — the merge is a standing line (proposed)

Merging an approved proposal is the only human action in the entire GitHub path, and it is gated exactly. A publication where `review.verdict === 'pass' && pull.state === 'open' && !pull.draft` and the signed-in actor is an operator is unambiguously **yours** under the standing line's policy. It belongs on `/now`. Flagging rather than assuming: this adds a source to the standing line, which the contract says "is policy and must stay small."

---

## 4. What to remove from today's Code page

| File                                                 | Action                                                                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/code/src/ui.ts`                            | Re-register the row: `group: 'settings'`, `path: '/settings/integrations/github'`, label `GitHub`; extend `read` with `publications`.                                                                                                                                                                                                                                                          | The rail keeps no Code row. Keeping one registration keeps the reads inside the plugin. ~0 net lines.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/ui/web/views/code.tsx` (156)               | **Delete entirely.**                                                                                                                                                                                                                                                                                                                                                                           | Two tables of identifiers. The "Sealed proposals" table is `ObjId` for the proposal, the instance, the producer and the manifest artifact; the operations table repeats it for the command, the instance and the worker. It violates the 2026-09-17 ruling outright, and the graph replaces every column with something a person can read: `summary` instead of the proposal id, the experiment's name instead of the instance id, the producer's name instead of the actor id, a dot and a diffstat instead of two hashes. |
| `packages/ui/web/components.tsx`                     | Leave `ObjId`, note the last caller.                                                                                                                                                                                                                                                                                                                                                           | Removing code.tsx leaves `settings.tsx` as the only user; the comment's promise then applies to one file.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `views/github-publications.tsx` (390)                | Remove: the per-file `<details>` list and inline `<pre>` patch rendering; the commits `<details>`; the GitHub reviews list; the "Refresh details" button. Restyle: the `Table` becomes hairline rows carrying branch pills + diffstat; the checks `<ul>` becomes the two-column hairline list. Keep: the publication list, the detail read, `status()`, the merge confirmation guard verbatim. | The removed blocks are the four things GitHub renders better. "Refresh details" goes because lists refresh themselves. ≈ −170 lines.                                                                                                                                                                                                                                                                                                                                                                                        |
| `views/github-publications.tsx` — "Sync with GitHub" | **Keep, and flag the label.**                                                                                                                                                                                                                                                                                                                                                                  | It is not a re-read: `syncPublications` reconciles one intent per poll and may create a branch and open a PR. The verb table has no verb for it, and inventing one is the founder's call, not mine. Leave the words as they are and raise it.                                                                                                                                                                                                                                                                               |
| `views/map.tsx:484`                                  | Retarget the Integrations tile.                                                                                                                                                                                                                                                                                                                                                                | The `/code` path stops existing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `views/github.tsx`, `views/github-automation.tsx`    | **No changes.**                                                                                                                                                                                                                                                                                                                                                                                | Codex's files, and they are correct. Only their placement moves, which happens in a new composing file.                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 5. Build plan — one wave

Codex has landed. `docs/GITHUB_PUBLICATION_READINESS.md` records live GitHub acceptance and production deployment on 2026-09-17. The blocking dependency is therefore not Codex's implementation but **the rail cleanup wave that removes the Code row**; this wave follows it.

| #   | File                                            | Change                                                                                                                                                                              | Lines     |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | `packages/ui/web/views/code-graph.tsx`          | **new** — `lanes(commands, proposals, publications, nameOf)` as a pure layout function (date scale → x, lane order → y, elbow paths), and one SVG component. No library, no canvas. | +180      |
| 2   | `packages/ui/web/views/integrations.tsx`        | **new** — the Integrations index tile and the GitHub page composing `<GitHubConnection/>`, `<CodeGraph/>`, `<GitHubPublications/>`.                                                 | +90       |
| 3   | `packages/ui/web/views/code.tsx`                | **delete**                                                                                                                                                                          | −156      |
| 4   | `packages/ui/web/views/github-publications.tsx` | trim diff/commits/reviews/refresh; PR row gets branch pills + diffstat; checks become hairline rows                                                                                 | −170      |
| 5   | `packages/ui/web/views/experiments.tsx`         | the lane in `history` when `workspace === 'git'`                                                                                                                                    | +25       |
| 6   | `packages/code/src/ui.ts`                       | move the row to `settings`; add `publications` to `read`                                                                                                                            | +6        |
| 7   | `packages/ui/web/views/map.tsx`                 | retarget the Integrations tile                                                                                                                                                      | 0         |
| 8   | `packages/ui/web/styles.css`                    | `.branch-graph` SVG classes, `.branch` pill, `.diff`, `.checks` rows; drop dead code-page rules                                                                                     | +60 / −40 |
| 9   | `packages/code/src/commands.ts`                 | optional: `list(caller, instanceId?)` mirroring `proposals`                                                                                                                         | +4        |

**Net ≈ +361 / −366 = −5 lines.** It clears the LOC rule, but only just, and honestly: deleting the identifier tables is what pays for the graph. If the founder wants real headroom, dropping (2) and putting the graph on the existing GitHub page is another −90.

Order: 5 (the experiment lane, smallest and most valuable) → 3 + 6 + 7 (remove the row) → 4 (trim the PR view) → 1 + 8 (the graph component) → 2 (the Integrations page).

Gates per the contract: `npm run typecheck:ui`, `npm run test:ui`, `node --import tsx --test tests/ui-navigation.test.ts`, `npm run build:ui`, `npm run format:check`, and the net line count of `packages/ui/web`.

### Blocked on Codex

1. **The trunk's own commits.** `packages/code/src/github-client.ts` has no repository-commits read; the only `GitHubCommit[]` is `pullDetails().commits`, scoped to one PR. Until there is one, the trunk is drawn with the points Merv can name and a dashed continuation. If the founder wants real trunk history, that is `GET /repos/{owner}/{repo}/commits?sha={base}` plus a `commits()` on `CodeGitHub` — **Codex's files, Codex's change.** Everything else in this wave works without it.
2. **The Integrations page.** `docs/PLUGIN_UI_MAP.md` records the integrations page as "shelved", and that doc is Codex's. Confirm with them before building item 2; items 1, 3–9 do not depend on it.
3. **Nothing else.** `code.list`, `code.proposals`, `GET /code/publications` and `GET /code/publications/<id>` all exist and are deployed.

---

## 6. Open questions for the founder

1. **The `Sync with GitHub` verb.** It performs a network reconciliation that can open a PR, so it is not "a control that only re-reads what is already on screen". No verb in the wave-4 table fits. Invent one (`Publish proposal`? `Start publication`?), or leave it outside the table like `Remove` and `Replace key…`?
2. **Does the whole-repository graph earn a page?** Every lane on it is a lane the experiment record already shows. The case for it is the trunk: only there can you see two experiments cut from the same base and one proposal landing. The case against is that it is the third copy of the same picture.
3. **Merge on Now.** Should an approved, open, non-draft publication be a standing line for operators? It is the only human gate in the path, but it adds a source to a policy the contract says must stay small.
4. **Failed checkpoints.** A `failed` or `cancelled` command has no receipt and therefore no dot. Silently absent, or one muted annotation on the lane?
