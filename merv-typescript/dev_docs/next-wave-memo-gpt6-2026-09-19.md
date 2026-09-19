# Reflection decides the next wave — gpt-6-astra, 2026-09-19

Second consult. The first proposed a director (`dev_docs/director-memo-gpt6-2026-09-19.md`);
the founder ruled that framing out: the decision belongs in the reflection result, and a
finished wave already opens a reflection. This memo answers within that ruling. The brief it
was given is `scratchpad/next-wave-prompt.md`.

The founder’s framing works. Reflection already owns the scientific decision; it needs an executable output and a deterministic handoff. I would keep `research.advance` forbidden to leased workers, make the change specification structured, and have `research` consume the approved specification when finishing the current cycle. No director assignment or `research.decide`.

The main distinction is **approval authorizes the next wave; cycle completion materializes it**. That preserves consolidation as a prerequisite without making reflection responsible for scheduling or creating another cycle.

**1. What the code establishes**

The existing implementation supplies most of the required guarantees:

- Research creates and pins its reflection inside the advance transaction. Its readiness checks currently require successful dependencies, not merely terminal ones. [Research coordinator](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/research/src/index.ts:427)
- Reflection approval already combines the workflow transition, review submission, paper acceptance, and immutable approved record in one transaction. [Reflection approval](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/reflections/src/index.ts:1142)
- Paper proposals retain the artifact hash, source revision, original document contents, evidence, author, and acceptance. Reuse that mechanism for document edits. [Paper proposal mechanism](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/paper/src/index.ts:462)
- Durable event consumers commit their effects and cursor together, retry after failure, and discover commits across connections. There is no need for another scheduler. [Domain events](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/domain-events/src/index.ts:176)

Two implementation discrepancies need addressing:

`Tasks.create` opens its own transaction and accepts no transaction argument. Composing it inside a batch currently produces `nested_transaction`; it does not provide batch atomicity. Add the ordinary optional `tx` argument and use `inTransaction`. [Task creation](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/tasks/src/index.ts:852)

Experiment creation still accepts task **or experiment** prerequisites. The founder’s constraint appears in the program commentary but is not enforced at creation. Tighten the service boundary, not just the proposed JSON validator. [Experiment creation](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/experiments/src/index.ts:269)

**2. Make the change specification one reviewed JSON envelope**

Keep `reportArtifactId` as prose: findings, uncertainty, disagreements, rejected alternatives, and the reasoning behind continuation or stopping.

For new reflection versions, make `changeSpecArtifactId` an immutable `application/json` artifact with this shape:

```ts
type ChangeSpec = {
  version: 1;
  problemRevision: number;
  documents: PaperDocumentEdit[]; // Existing Methods/Results edit schema; [] allowed
  consolidation: string;         // Reviewed implementation instructions

  next:
    | {
        decision: "continue";
        name: string;
        rationale: string;
        evidenceIds: string[];
        work: WorkItem[];         // Nonempty, bounded
      }
    | {
        decision: "stop";
        reason:
          | "goal_met"
          | "no_worthwhile_next_step"
          | "needs_owner"
          | "limit_reached";
        rationale: string;
        evidenceIds: string[];
        work: [];
      };
};

type WorkItem =
  | {
      key: string;
      kind: "task";
      title: string;
      goal: string;
      checks: string[];
      dependsOn: string[];        // Local keys in this envelope
      evidenceIds: string[];
    }
  | {
      key: string;
      kind: "experiment";
      name: string;
      intent: string;
      details: string;
      testedClaimIds: string[];   // Existing project claims
      dependsOn: string[];
      feasibilityTask: string;   // A task among those prerequisites
      evidenceIds: string[];
    };
```

Use the existing field limits and validation wherever possible. Fix task type, workspace policy, ownership, and workflow versions server-side. Resolve local keys to generated IDs in topological order. Initially allow only local dependency references; existing research enters through evidence references. That makes the proposed wave bounded and avoids capturing unrelated live work.

Enforce task → experiment → task ordering, with no experiment → experiment edges. Under the stated “only” constraint, also reject task → task edges in this envelope. Dependencies of the outer research coordinator remain a separate relationship.

The artifact must be unable to express:

- Arbitrary tool calls, SQL, callbacks, shell execution by the proposal interpreter, or workflow definitions.
- Actor identities, permissions, review exclusions, credentials, or runner configuration.
- Approved experiment designs or fabricated completed work.
- Mutations or deletions of existing research records.
- Problem/scope expansion, higher automation limits, multiple successors, or another recursive plan.
- Direct Git publication.

Research instructions can contain commands for a future worker to inspect; those strings are never executed by the proposal interpreter.

Fold paper edits into this envelope for new reflections. Keep the old optional `paperChangesArtifactId` path for old versions and existing experiment submissions. Reflection validates the entire envelope; `paper.propose` still derives and validates the document portion from the same retained bytes and pins that artifact. Do not introduce another proposal table, acceptance engine, or generic command language.

The existing paper parser is strict, so this requires an explicit new envelope format path; simply adding fields to today’s paper artifact will fail validation.

**3. Apply it in the final advance transaction**

Use two existing boundaries:

| Boundary | Effect |
|---|---|
| Reflection review approval | Accept the immutable specification and apply its paper edits, using the existing paper mechanism. |
| Final research advance | Complete the current cycle and atomically materialize its approved successor, if any. |

For a cycle without consolidation, the second boundary is `reflecting → complete`. With consolidation, it is `consolidating → complete`.

The final `ResearchService.advance` transaction should:

1. Read the exact approved reflection and verify its pinned specification.
2. Recheck authority, goal revision, limits, prerequisites, and required consolidation.
3. Create all proposed tasks and experiments through their services, passing the same transaction.
4. Create the successor cycle with exactly those selected work IDs.
5. Pin inherited goal and proposal provenance, and advance the successor through `defining`.
6. Complete the predecessor and record the materialization receipt.

Store the local-key-to-record-ID mapping in the successor’s immutable record. Derive request IDs from the predecessor, approved artifact hash, and local key.

If record four fails, **all records, transitions, receipts, and events in this transaction roll back**. The earlier reflection approval and paper edits remain accepted; they belong to the earlier transaction. No partially created wave becomes dispatchable.

Artifact creation may leave unreferenced content-addressed blobs after rollback; that is storage cleanup, not partially committed research.

Preflight at submission and approval should catch malformed graphs, impossible names, unavailable capabilities, and oversized selections. Recheck at execution because project state can change. Never silently rename, truncate, omit, or reinterpret approved work after a failure.

A permanently inapplicable approved proposal becomes an explicit continuation blocker. Approved reflections remain immutable: changing their scientific decision requires another review, not patching their bytes.

**4. Open a successor record; keep the straight line**

Publish `research@5`, retaining the existing states and edges. Its changed behavior is automatic coordination and consumption of the reflection’s decision. Do not add `complete → defining`.

Add nullable, immutable `predecessor_id`, with a unique constraint for non-null values. Validate same-project ancestry. This buys an important invariant cheaply: one predecessor can create at most one successor, including under concurrent delivery or different request IDs.

Carry forward:

- The accepted problem/scope/goals/constraints revision.
- The original automation authorization and remaining allowance.
- The approved reflection, specification hash, review, and work mapping.
- A narrower next-wave objective, expressed by its name and proposed work.

The synthesis may refine the next question within the goal; it cannot replace the goal. A changed problem revision blocks automatic continuation until the owner resolves it.

Standalone reflections can produce this format, but cannot create cycles unless attached to an authorized research cycle. Likewise, legacy prose specifications remain prose; never make an LLM parse old approved text into newly executable authority.

There is a separate Git dependency: consolidation approval currently records `centralGit: 'not-published'`, while experiment execution uses central as its base. [Consolidation completion](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/consolidation/src/index.ts:809) A successor that relies on consolidated code must wait for a verified usable base. Initially, block that handoff explicitly. Later, connect it to the existing publication machinery through a transaction-safe retained-status read. Do not treat scientific approval as permission to publish.

**5. Advance automatically through a server event consumer**

Keep the session rejection in `research.advance`. Do not make synthesis, its reviewer, or the last experiment worker temporarily privileged.

Have `research` subscribe through `domainEvents` and reconcile authorized `research@5` cycles after relevant workflow transitions, reflection approvals, consolidation completion, and replanning. Use the event as a wake-up; evaluate current records rather than trusting its payload.

Capture the owner’s existing `DelegationSource` when automation is enabled, and revalidate it before acting. This is bounded authority granted by the owner, not a new actor or research role. Never manufacture authority by removing `caller.session` from a worker’s caller.

Three details are necessary:

- **Terminal research is not successful research.** In version 5, the researching gate accepts selected tasks/experiments that are terminal, including failed and abandoned work. Reflection should examine those outcomes.
- **Do not weaken execution dependencies.** Tasks and experiments still require successful prerequisites. The outer cycle is observing outcomes; an experiment is consuming usable inputs.
- **Failure must propagate to blocked descendants.** Current `dependencyFailureAction` supplies guidance; it does not execute the ending. The coordinator must terminalize selected, never-started descendants whose prerequisites failed, using existing domain ending methods and explicit reasons. Otherwise the wave never becomes all-terminal.

Later research gates must inspect their reflection/consolidation children rather than repeatedly demanding success from every original research dependency.

Only reconcile the selected wave, not every project record. Handle empty selections explicitly: reject an empty automatic initial wave rather than repeatedly reflecting on nothing.

Use durable replay from the beginning with a version/authorization filter, so restart cannot lose a handoff. Ordinary waiting conditions should return normally. Expected permanent blockers should be recorded and exposed without poisoning the global event cursor; unexpected storage failures should roll back and retry.

**6. Existing exclusions need new provenance, not a new exclusion system**

Today the lease hooks exclude actors from reviews using `excludedFromReview`. They do not exclude a proposal author from producing a future task or experiment. The current machinery alone is therefore insufficient. [Task lease exclusions](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/tasks/src/index.ts:292)

At materialization, derive immutable origin metadata from the approved reflection:

```text
reflection ID, specification hash, review ID,
synthesis author, approving reviewer, directing authorities
```

Neither the synthesis author nor approving reviewer may produce the resulting work, including experiment design. Apply that check during candidate selection, lease acquisition, and producer mutations; checking dispatch alone leaves interactive and direct-service paths open.

Retain the existing rule excluding a producer and its directing authority from reviewing its output. Carry proposal contributors into downstream review exclusions as well, so moving the work into another record does not erase their contribution.

Reuse the existing lease `excludes` hook and review `excludedActorIds`; add the missing producer check. Store provenance once on the generated record, with no general relationship registry.

Do not exclude every worker sharing a human operator: that would eliminate most unattended execution. Exclude the implicated actors themselves, preserve source-authority exclusions for reviews, and acknowledge that fresh actor IDs cannot prove intellectual independence. Persistent agent identity and clean reviewer context matter; actor separation is necessary, not sufficient.

**7. Stopping must be explicit and modest**

An approved empty wave means **no automatic successor**. It does not inherently mean the project succeeded.

Require the explicit stop reason above:

- `goal_met`: reviewed evidence supports the pinned goal’s completion.
- `no_worthwhile_next_step`: stop pursuing this question without claiming success.
- `needs_owner`: scope, authority, or another decision exceeds the reflection’s mandate.
- `limit_reached`: the authorized continuation allowance is exhausted.

The smallest honest resource policy is an owner-set finite number of successor waves, plus a maximum proposal size. Keep these outside model-authored changes and decrement atomically with materialization. Existing experiment limits still apply; today there may be at most seven active experiments.

This bounds growth, **not spending**. One experiment or repeated reviews can consume substantial resources. Reflection may judge that further work is not worthwhile, but Merv cannot truthfully claim a dollar budget has been respected.

If an operational spending proxy is required, add a finite lease-offer allowance across the lineage and enforce it in `sessions`, including retries and reviews. Existing per-session deadlines alone do not bound repeated sessions. Even an offer allowance does not meter external training jobs.

A `goal_met` decision closes this research lineage. Display “project finished” only when no other active project work contradicts that label. An owner can still explicitly reopen research.

**8. Put feasibility before the expensive experiment**

Use the structured specification to require an actual prerequisite task; enforce its success through the existing experiment dependency gate.

A feasibility task should establish, with a small bounded probe or analytical calculation:

- That the proposed regime can exhibit the effect.
- That the measurement can detect a useful effect size.
- That a positive control responds and the baseline behaves plausibly.
- That the proposed grid crosses the relevant regime.
- The concrete go/no-go thresholds and retained evidence.

“Ran the probe” is not a sufficient Done-when check. The task must establish permission to proceed. A sound probe that finds the regime unsuitable blocks the expensive experiment; retain that scientific result even though the prerequisite did not succeed.

For these gates, require the critical acceptance findings to be **met**, not waived. Otherwise today’s review semantics can approve a task while waiving its feasibility condition.

The experiment’s existing design review must then check that its exact plan remains within what the feasibility evidence supports. A changed regime needs new evidence. Lens instructions should recommend good probes, but instructions alone do not enforce this ordering.

This reduces wrong-regime risk; it cannot guarantee informativeness. Two models can still agree on a bad pilot, and a short run can miss a late-emerging effect.

**9. Remove the project-wide creation freeze in the new reflection version**

Remove `blocksStarts: ['task', 'experiment']` from `reflection@3`. Preserve it byte-identically in version 2.

The freeze appears intended to prevent new research from racing ahead of reflection and consolidation. It never froze the evidence completely: existing work can progress, and current reflection instructions explicitly tell workers to revisit live research.

Replace its broad effect with narrower guards:

- One open reflection per project, as today.
- No successor materialization before exact approval and the final cycle gate.
- Immutable submitted artifacts and review revision fencing.
- Explicit goal/code-base checks at handoff.

Ordinary task and experiment creation need not stop during three rounds of synthesis. Unrelated new work does not automatically join the cycle’s selected wave.

Strictly, the current freeze would not block creation *after* reflection approval because `approved` is terminal. Removing it is about avoiding the long project-wide freeze, not enabling a privileged exception during synthesis.

**10. Failure modes and cheapest guards**

| Failure mode | Cheapest guard |
|---|---|
| Both models endorse scientifically useless work | Small feasibility prerequisite, positive control, exact-plan design review |
| Fabricated evidence or overstated certainty | Existing artifact references; reviewer opens retained evidence; preserve uncertainty |
| Runaway scope or work multiplication | Strict schema, inherited goal, bounded work count, owner-set continuation allowance |
| Endless revision or infrastructure retries | Visible exhaustion policy; lease-offer cap if operational bounding is required |
| Duplicate delivery creates two waves | Revision CAS, deterministic request IDs, unique predecessor |
| One record fails halfway through creation | One explicit transaction passed through every service |
| New authority is smuggled through JSON | No actor, permission, command-dispatch, or policy fields |
| Proposal author becomes downstream producer/reviewer | Immutable origin metadata and admission checks beyond dispatch |
| Failed prerequisites leave the project idle forever | Deterministic descendant ending, then reflection over all terminal outcomes |
| Approved proposal becomes stale | Revalidate at handoff; expose a blocker; never rewrite approved bytes |
| Approved consolidation is absent from execution’s base | Verified code-base gate; approval is not publication |
| One bad event stalls unrelated projects | Treat expected blockers as outcomes, not indefinitely retried exceptions |
| Empty proposal is mistaken for success | Explicit stop decision and reason |
| Startup fails after a policy edit | Add versions; preserve published fingerprints and test production-shaped startup |

**11. Packages, versions, and implementation order**

I would stage the work in this order:

| Rank | Work | Packages and versions |
|---|---|---|
| 1 | Enforce dependency direction and introduce real feasibility prerequisites | `experiments`, `tasks`, `contracts`; new `experiment@5/6` and affected experiment recipes `@7`; `task@3` for new admission behavior |
| 2 | Strict structured reflection output, unified document envelope, explicit stop decision | `reflections`, `paper`, `contracts`; `reflection@3`, reflection recipes `@5` |
| 3 | Remove the creation freeze | Same `reflection@3` release |
| 4 | Atomic successor creation and provenance exclusions | `research`, `tasks`, `experiments`, `contracts`; `research@5`, transaction-compatible task methods |
| 5 | Durable automatic advancement, including failed dependency closure | `research` consuming `domainEvents`; keep worker manifests unchanged |
| 6 | Operational lease allowance and automatic Git-base handoff | `sessions`, `code`, `research`; defer until the bounded loop is proven |

Currently `createLenses` selects the child workflow version from the parent version. Either publish `reflection.lens@3` alongside the parent—my preference—or explicitly decouple that mapping. Do not accidentally look up a nonexistent child handle.

If proposal-producer exclusions also cover the current consolidation implementation, publish `consolidation@5/6` and apply the same origin checks there. Otherwise its workflow and recipes need no change for successor creation.

Keep all currently registered historical definitions, execution policies, and recipes unchanged and available. Do not repurpose fixture entries already marked retired. Add new fingerprints; never “repair” published fingerprints to match changed code.

Required verification is concentrated: mid-batch rollback on SQLite and PostgreSQL, duplicate/concurrent event delivery, restart recovery, failed prerequisite closure, forbidden producer reuse, revoked authority, stale goal/base, and startup against published fingerprints. The current fingerprint test is an essential gate, not the whole migration test.

The net-source-line constraint is a real implementation constraint, not something this memo can certify. A concrete deletion candidate is the read-reference extension machinery: project-wide reads now bypass its original purpose, and research is its only production provider. Remove that obsolete path only after checking its remaining callers; keep published manifests intact. Reuse existing paper acceptance, event delivery, leases, and domain creation methods, and avoid a generic proposal framework.

Each merge should demonstrate a negative source-line delta under unchanged counting rules. If those deletions do not fund a safe increment, combine or reduce the increment; do not claim the requirement was met through formatting.

Nothing in the founder’s framing prevents this design. What cannot honestly follow from it is unlimited unattended execution, guaranteed scientific judgment, dollar-budget enforcement, or automatic publication. Reflection can decide the next wave; the server must enforce the narrow conditions under which that decision takes effect.
