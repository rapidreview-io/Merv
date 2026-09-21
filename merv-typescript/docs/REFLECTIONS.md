# Reflections over live research

Reflections is a peer domain program alongside Tasks and Experiments. Research coordinates the outer cycle; Reflections owns five independent lenses, synthesis, and independent review. It depends on State, Scope, Artifacts, Paper, Workflows, Reviews and Context Builder. It does not depend on Knowledge or Research.

New waves use `reflection@2` and `reflection.lens@2`. They read live research. Creating a wave does not capture a Knowledge snapshot, copy the paper, or create an input artifact. Only one unfinished wave can exist in a project.

## Work during a wave

An active reflection declares `blocksStarts: ['task', 'experiment']` in its durable workflow definition. Workflows checks this inside the creation transaction. New task/experiment creation is rejected with `workflow_creation_paused`; existing tasks, experiments, reviews and evidence uploads continue. Previously committed create requests can still replay. The five lens workflows are allowed to start.

The pause is project-scoped and survives unloading Reflections or restarting the server because it follows the stored workflow state. Approval ends it in the same transaction. Returning a review to synthesis or fresh lenses keeps the pause active. There is no separate pause flag to clear. Legacy version-1 waves retain their original behavior.

The pause stays now that an approved plan can become work. That work is created after `approved`, which is terminal, so the pause never blocks it; and while the wave is open it keeps the project the plan was written about from moving under the reviewer. Lifting it would also need new definitions: a definition's fingerprint covers its name, version, initial state, states, terminal states, edges, `managed` and `blocksStarts`, so a changed `blocksStarts` is a `reflection@3` and `reflection.lens@3`. The execution-policy fingerprint covers only the tool manifest, which is why instruction and recipe text can change without a new definition.

## Context and reads

A lens receives its assignment, perspective, live-read instructions and any relevant feedback. Synthesis and review receive references to submitted reports instead of their complete contents. No complete research corpus is embedded in an assignment. These contexts use version-5 reflection recipes; packages saved under earlier versions remain readable.

Version 5 adds two optional sections after `feedback`. `history` gives a lens or synthesis author every earlier rejected round of the wave, oldest first, in the bounded form described in [Rework history](RECOVERY_AND_CONTEXT.md#rework-history) (6000 characters, oldest rounds dropped first); the `feedback` section itself is unchanged, and the reviewer's recipe has no `history` section, so a reviewer is shown no earlier verdicts. `references.researchReviews` names the review of every rejected round. `previousCycle` embeds the digest of the research cycle before this wave's, under the heading "Predecessor cycle digest (decisions already made; verify before relying on it)"; all three stages receive it. It comes last, so rework feedback wins the budget: a digest that does not fit is named in `omitted` and stays in `references.artifacts` for `artifact.read`. Only such a wave's live-read instructions name `research.lineage`.

The digest reaches a wave through `ReflectionCreate.previousCycleDigestId`, which Research sets when it advances a cycle that follows another. It is validated as an artifact of the project and kept in the wave's workflow start data, which no later transition rewrites. The `reflection.create` tool does not accept it: otherwise any writer could present an artifact of their choosing to every lens and reviewer as decisions already made.

Agents use existing tools: `project.records`, `task.get`, `experiment.get_state`, `paper.read`, `review.get`, `artifact.get` and `artifact.read`. No tools or tool schemas were added. `project.records` still returns the existing full metadata inventory on demand; this change does not add pagination or automatic summarization.

Research registers an optional read-reference resolver with Workflows and obtains current research-linked artifact and review IDs from Knowledge. Workflows consults it only when an existing artifact/review read needs additional evidence references, including evidence attached after an agent received its assignment. It cannot grant new tools or writes or replace fixed assignment fields. Project authorization and the fixed tool policy still apply. Unattached files and peer lens reports are not included in research reads. Lens agents cannot call `reflection.get` or read other lens outputs directly. Research records and paper may change during the wave; agents should explain what they examined and distinguish ongoing work from completed results.

Unloading Research (including when Knowledge unloads) removes this resolver and the `reflection.create` tool. Reflections remains active: assignments, leases, own output reads and submissions do not consult Knowledge. Additional research evidence reads are denied until Research reloads; the same agent can then resume them. This is an optional runtime collaboration, not a Reflections lifecycle dependency. In-process callers may also use `Reflections.create` directly for standalone waves.

## Completion

Five different agent identities submit their own immutable lens reports, each with a nonempty Summary. The last submission opens synthesis. Synthesis submits its report, change specification and optional paper changes for independent review. Reports and verdicts remain immutable even though the research they analyze is live.

Approval retains the exact submitted outputs, contributors and review. When Research advances to consolidation, it selects current research-linked evidence and terminal experiment IDs through Knowledge and passes them alongside the approved reflection outputs into Consolidation. Evidence added since reflection approval is input for Consolidation's own review, not retroactively part of that approval. New waves do not populate the legacy `experimentIds` field; legacy approvals retain their original experiment scope and corpus references.

Synthesis can propose Methods/Results changes using `paperChangesArtifactId`; agents obtain current paper revisions through `paper.read`, and reviewers inspect the exact proposal and original text through `reflection.get`. Accepted edits apply atomically with reflection approval. Rejection leaves them unapplied. See [Living paper](LIVING_PAPER.md).

A review may send a reflection back, to its synthesis or to its lenses, at most
`limits.reviewReturns` times in total (Reflections config, default 2): the
`review_returns` [loop limit](BUDGETS_AND_LIMITS.md) on the parent workflow. Restarting
the lenses opens five more sessions, so this caps that fan-out. An escalated reflection
has no abandon edge: its only exits are a human approval or an admin's
`workflow.extend_limit`, and while it waits it still pauses new tasks and experiments, as
any open wave does. Lens sessions are counted in the wave's and the cycle's usage.

## Structured change specification

The change specification has two formats, told apart by the artifact's media type alone. Any media type other than `application/json` is the text format: it is reviewed as prose, never parsed, and creates no work. An `application/json` change specification is parsed at `reflection.submit` against a strict schema; a refusal is `invalid_change_spec` (400) naming the field or item, and leaves the wave in `synthesizing` at the same revision.

```ts
{
  version: 1,
  changes: string,                    // prose scope, claim and consolidation changes, ≤ 8000
  next: { decision: 'continue', name: string, rationale: string }
      | { decision: 'stop', reason: 'goal_met' | 'no_worthwhile_next_step' | 'needs_owner', rationale: string },
  items: (                            // ≤ 12, of which ≤ 7 experiments
    | { key, kind: 'task', title, goal, checks: string[], dependsOn: string[], rationale }
    | { key, kind: 'experiment', name, question, details, testedClaimIds: string[], dependsOn: string[], rationale }
  )[],
  carriedOver: { workflowId, reason }[],  // ≤ 20 existing tasks or experiments
  rejected: { title, reason }[],          // ≤ 20
}
```

The whole document is at most 64,000 bytes; `goal`, `question` and `details` at most 4000 characters, each `rationale` and `reason` at most 1000, a task 1–12 one-line checks, distinct without regard to case or spacing as Tasks compares them. The limits follow what a reviewer can read from a bounded context, since the plan travels in the submission, the approval and every `reflection.get`. Keys are unique; `dependsOn` names other items' keys, never the item's own, without cycles or repeats; an experiment depends only on tasks; experiment names are unique without regard to case. `stop` carries no items and no carried-over work; `continue` carries at least one of either. Each `carriedOver.workflowId` is checked at submit to be a task or experiment in this project, named once. What depends on later project state — claim existence, name conflicts, the active-experiment limit — is judged by Research when the work is created.

A parsed plan adds one frozen criterion to the synthesis review, before the optional paper criterion: every item follows from cited lens evidence, has checkable checks or a falsifiable question, names only existing claims and orders cheap feasibility work first; rejected alternatives and carried-over work are recorded honestly; a stop is justified. The reviewer returns one finding per criterion as before. A resubmission after `revise_synthesis` is parsed afresh, so switching to text clears the plan and its criterion.

`reflection.get` returns the parsed `plan` (null for a text specification), and approval retains it in the immutable `ApprovedReflection.plan`. Nothing in Reflections creates work and no tool or grant was added: synthesis still holds exactly `artifact.create` and `reflection.submit`. The project owner decides whether the plan becomes work when completing the research cycle; see [Research: Next wave](RESEARCH.md#next-wave). A standalone wave's plan is reviewed and retained but creates nothing.

Synthesis and review use version-5 recipes that describe both formats; the review text speaks of the plan only "when `reflection.get` returns a plan", because waves already open when the recipes changed receive them too. The lens recipe stays at version 4.

## Existing tools

- `reflection.create`: start a live wave and pause new tasks/experiments; registered by Research's existing tool adapter.
- `reflection.list` / `reflection.get`: read waves, outputs and review state.
- `reflection.lens`: read one lens and its own output.
- `reflection.submit_lens`: complete a lens.
- `reflection.submit`: submit synthesis for review.
- `review.submit`: pass or return synthesis/lenses through the existing review owner.

Mutation replay, revision checks, independent review, lease recovery and immutable outputs are unchanged. Existing version-1 waves and their snapshots remain supported; new waves return `corpus: null` and `paper: null`.
