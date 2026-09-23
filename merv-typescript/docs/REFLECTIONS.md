# Reflections over live research

Reflections is a peer domain program alongside Tasks and Experiments. Research coordinates the outer cycle; Reflections owns five independent lenses, synthesis, and independent review. It depends on State, Scope, Artifacts, Paper, Workflows, Reviews and Context Builder. It does not depend on Knowledge or Research.

Waves use `reflection@3` and `reflection.lens@2`; earlier versions are [retired](#retired-versions). They read live research. Creating a wave does not capture a Knowledge snapshot, copy the paper, or create an input artifact. Only one unfinished wave can exist in a project.

## Work during a wave

An active reflection declares `blocksStarts: ['task', 'experiment']` in its durable workflow definition. Workflows checks this inside the creation transaction. New task/experiment creation is rejected with `workflow_creation_paused`; existing tasks, experiments, reviews and evidence uploads continue. Previously committed create requests can still replay. The five lens workflows are allowed to start.

The pause is project-scoped and survives unloading Reflections or restarting the server because it follows the stored workflow state. Approval ends it in the same transaction. Returning a review to synthesis or fresh lenses keeps the pause active. There is no separate pause flag to clear.

The pause stays now that an approved plan can become work. That work is created after `approved`, which is terminal, so the pause never blocks it; and while the wave is open it keeps the project the plan was written about from moving under the reviewer. Lifting it would also need new definitions: a definition's fingerprint covers its name, version, initial state, states, terminal states, edges, `managed` and `blocksStarts`, so a changed `blocksStarts` needs new `reflection` and `reflection.lens` versions. The execution-policy fingerprint covers only the tool manifest, which is why instruction and recipe text can change without a new definition.

## Context and reads

A lens receives its assignment, perspective, live-read instructions and any relevant feedback. Synthesis and review receive references to submitted reports instead of their complete contents. No complete research corpus is embedded in an assignment. These contexts use lens recipe 7 and synthesis and review recipe 8; packages saved under earlier versions remain readable.

Version 5 adds two optional sections after `feedback`. `history` gives a lens or synthesis author every earlier rejected round of the wave, oldest first, in the bounded form described in [Rework history](RECOVERY_AND_CONTEXT.md#rework-history) (6000 characters, oldest rounds dropped first); the `feedback` section itself is unchanged, and the reviewer's recipe has no `history` section, so a reviewer is shown no earlier verdicts. `references.researchReviews` names the review of every rejected round. `previousCycle` embeds the digest of the research cycle before this wave's, under the heading "Predecessor cycle digest (decisions already made; verify before relying on it)"; all three stages receive it. It comes last, so rework feedback wins the budget: a digest that does not fit is named in `omitted` and stays in `references.artifacts` for `artifact.read`. Only such a wave's live-read instructions name `research.lineage`.

The digest reaches a wave through `ReflectionCreate.previousCycleDigestId`, which Research sets when it advances a cycle that follows another. It is validated as an artifact of the project and kept in the wave's workflow start data, which no later transition rewrites. The `reflection.create` tool does not accept it: otherwise any writer could present an artifact of their choosing to every lens and reviewer as decisions already made.

Agents use existing tools: `project.records`, `task.get`, `experiment.get_state`, `paper.read`, `review.get`, `artifact.get` and `artifact.read`. No tools or tool schemas were added. `project.records` still returns the existing full metadata inventory on demand; this change does not add pagination or automatic summarization.

A wave's workers read live research through these tools. Since 2026-09-17 a session's reads are bounded by the project alone: a read-only call the fixed policy does not name, or names with other arguments, is admitted as given, and the policy only fills in the references it names (the artifacts pinned in the assignment, the wave's earlier review rounds). So a lens can also call `reflection.get` on its wave and read what its peers have submitted; the independence of the five lenses rests on five distinct agents, not on what each can see. Every write still holds as published. Research records and paper may change during the wave; agents should explain what they examined and distinguish ongoing work from completed results.

Unloading Research removes the `reflection.create` tool. Reflections remains active: assignments, leases, reads and submissions consult neither Research nor Knowledge. In-process callers may also use `Reflections.create` directly for standalone waves.

## Completion

Five different agent identities submit their own immutable lens reports, each with a nonempty Summary. The last submission opens synthesis. Synthesis submits its report and change specification for independent review. Reports and verdicts remain immutable even though the research they analyze is live.

Approval retains the exact submitted outputs, contributors and review. Research reads that approval when it completes the cycle or injects its consolidation task; evidence added since approval is not retroactively part of it.

The reflection reviewer owns cross-experiment Methods/Results updates. Read the current paper and integrate verified findings using `review.submit.paperChanges`. These reviewer-authored edits save atomically with any valid verdict, with rejection and uncertainty stated honestly. If no edits are warranted, explain why in review notes. Synthesis no longer supplies paper edits. See [Living paper](LIVING_PAPER.md).

A review may send a reflection back, to its synthesis or to its lenses, at most
`limits.reviewReturns` times in total (Reflections config, default 2): the
`review_returns` [loop limit](BUDGETS_AND_LIMITS.md) on the parent workflow. Restarting
the lenses opens five more sessions, so this caps that fan-out. An escalated reflection
has no abandon edge: its only exits are a human approval or an admin's
`workflow.extend_limit`, and while it waits it still pauses new tasks and experiments, as
any open wave does. Lens sessions are counted in the wave's and the cycle's usage.

## Structured change specification

The change specification has two formats, told apart by the artifact's media type alone. Waves created by automatic Research require the JSON format and an explicit continue/stop decision; this requirement is frozen in the assignment and enforced at submission. Other waves retain both formats. Any media type other than `application/json` is the text format: it is reviewed as prose, never parsed, and creates no work. An `application/json` change specification is parsed at `reflection.submit` against a strict schema; a refusal is `invalid_change_spec` (400) naming the field or item, and leaves the wave in `synthesizing` at the same revision.

```ts
{
  version: 2,
  changes: string,                    // prose scope and consolidation changes, ≤ 8000
  next: { decision: 'continue', name: string, rationale: string }
      | { decision: 'stop', reason: 'goal_met' | 'no_worthwhile_next_step' | 'needs_owner', rationale: string },
  items: (                            // ≤ 12, of which ≤ 7 experiments
    | { key, kind: 'task', title, goal, checks: string[], dependsOn: string[], rationale, workspace }
    | { key, kind: 'experiment', name, question, details, dependsOn: string[], rationale, workspace }
  )[],
  carriedOver: { workflowId, reason }[],  // ≤ 20 existing tasks or experiments
  rejected: { title, reason }[],          // ≤ 20
}
```

Each item requires `workspace: { provider: "none" } | { provider: "code", version: 1 }`. Choose Code when the deliverable is code in the project's repository, and none for analysis, reports or work needing no checkout. The strict schema rejects `baseTaskId`, commits and branches, including inside `workspace`; dependencies determine the base. Version 1, which declared no workspaces and was written only by the retired `reflection@2`, is refused like any other version.

The whole document is at most 64,000 bytes; `goal`, `question` and `details` at most 4000 characters, each `rationale` and `reason` at most 1000, a task 1–12 one-line checks, distinct without regard to case or spacing as Tasks compares them. The limits follow what a reviewer can read from a bounded context, since the plan travels in the submission, the approval and every `reflection.get`. Keys are unique; `dependsOn` names other items' keys, never the item's own, without cycles or repeats; an experiment depends only on tasks; experiment names are unique without regard to case. `stop` carries no items and no carried-over work; `continue` carries at least one of either. Each `carriedOver.workflowId` is checked at submit to be a task or experiment in this project, named once. What depends on later project state — name conflicts, the active-experiment limit — is judged by Research when the work is created.

A parsed plan adds one frozen criterion to the synthesis review, covering these checks: every item follows from cited lens evidence, has checkable checks or a falsifiable question, orders cheap feasibility work first; rejected alternatives and carried-over work are recorded honestly; a stop is justified. The reviewer returns one finding per criterion as before. A resubmission after `revise_synthesis` is parsed afresh, so switching to text clears the plan and its criterion.

`reflection.get` returns the parsed `plan` (null for a text specification), and approval retains it in the immutable `ApprovedReflection.plan`. Nothing in Reflections creates work and no tool or grant was added: synthesis still holds exactly `artifact.create` and `reflection.submit`. The project owner decides whether the plan becomes work when completing the research cycle; see [Research: Next wave](RESEARCH.md#next-wave). A standalone wave's plan is reviewed and retained but creates nothing.

Synthesis and review use recipe 8, which describes version-2 plans and asks reviewers to verify each workspace declaration against its deliverable; lenses use lens workflow 2 and lens recipe 7. Synthesis and review recipe 7 are no longer registered; their text remains in the source only because recipe 8 is derived from it. The review context references the exact specification artifact, and `reflection.get` exposes every declaration in the parsed plan.

## Existing tools

- `reflection.create`: start a live wave and pause new tasks/experiments; registered by Research's existing tool adapter.
- `reflection.list` / `reflection.get`: read waves, outputs and review state.
- `reflection.lens`: read one lens and its own output.
- `reflection.submit_lens`: complete a lens.
- `reflection.submit`: submit synthesis for review.
- `review.submit`: pass or return synthesis/lenses through the existing review owner.

Mutation replay, revision checks, independent review, lease recovery and immutable outputs are unchanged.

## Retired versions

`reflection@1`–`2` and `reflection.lens@1` can no longer start, so they are not registered. The
`reflections@2` migration deleted their waves, lenses, leases and command receipts, and those
of every `reflection@3` wave a retired research cycle had opened as its reflecting stage. Their
ids stay listed in `wf_retired_instances` and the `events` log still names them; their artifacts
are kept. `reflection.get` and `Reflections.approved` no longer return `corpus`, `paper`,
`experimentIds` or `paperProposal`: only the retired waves could hold them.
