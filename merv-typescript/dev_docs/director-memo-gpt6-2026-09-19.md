Merv should carry the director as an assignment on the research cycle. The existing lease, revision fence, frozen context, and independent review machinery are the right foundation. The missing pieces are a bounded decision handoff, durable ownership of commissioned work, and limits enforced outside the director’s judgment.

I would authorize autonomy against a fixed project mandate: the question, scope boundaries, acceptable evidence, and an effort allowance. The director may choose how to pursue that mandate. It cannot redefine success or replenish its allowance.

Several details in the code materially affect this design:

- Research registers versions 2–4, has action rules but no assignments, and explicitly refuses session callers in `authorize`. Adding a manifest alone will not make it executable. [ResearchService](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/research/src/index.ts:349)
- A worker’s own revision-changing operation is its handoff. A director cannot replan its cycle and then keep operating under the old lease. [Session handoff](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/sessions/src/index.ts:534)
- The reflection freeze is not a consistency boundary: v2 blocks new tasks and experiments, while its assignments explicitly read changing live research and embed no corpus. [Reflection definition](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/reflections/src/definitions.ts:30), [reflection inputs](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/reflections/src/index.ts:521)
- Server reads are open, but the Codex launcher still sets `enabled_tools` from the fixed manifest. That can hide the very project reads the preamble tells workers to perform. [Codex launch](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/runner/src/profiles.ts:331)

1. **Give the director one bounded decision per assignment.**

   Publish `research@5`, with director assignments on `defining`, `researching`, `reflecting`, and `consolidating`. Their admission must be independent of advance readiness. In particular, do **not** set `requiresDependencies: true`: failed or unfinished prerequisites are often precisely why the director is needed.

   I recommend one new domain command, `research.decide`, bound to the assigned `researchId` and `expectedRevision`. It accepts a small, closed decision schema:

   | Decision | Effect |
   |---|---|
   | Define | Adopt an exact reviewed problem/scope/goals/constraints proposal. |
   | Commission | Create a bounded batch of tasks or experiments and update the cycle’s selection. |
   | Resolve | End identified, cycle-owned work and reselect dependencies, retaining reasons and evidence. |
   | Advance | Perform the existing guarded stage handoff, including reflection or consolidation creation. |
   | Wait | Record what event or deadline warrants reconsideration. |
   | Finish or continue | End the authorized run, or create exactly one successor cycle within the same mandate and remaining allowance. |

   This is a research command, not a generic batch-tool interpreter. No arbitrary tool names, caller identities, SQL, or workflow transitions belong in its input.

   Validate the decision and apply its domain operations in one transaction. Record its evidence basis, created IDs, changes to selection, and rationale. A same-state decision edge advances the cycle revision and closes the lease even when the decision is “wait.” Stable command replay prevents a lost response from commissioning the batch twice.

   This atomic boundary matters: separate `task.create`, `experiment.create`, and `research.replan` calls otherwise leave partially commissioned work after a crash. Existing replay keys include the actor, so a replacement director actor does not automatically deduplicate its predecessor’s intentions.

   The director’s execution policy should contain:

   - `readOnly: false`, because it changes coordination records.
   - `workspace: { mode: 'none' }`.
   - `research.decide`, with target bindings for cycle and revision.
   - `artifact.create`, if the decision needs retained proposals or supporting analysis.
   - Its own assignment and status reads. All genuine project reads remain available independently of write grants.

   It must receive no review submission, experiment delivery, reflection synthesis, claim acceptance, Git publication, identity administration, runner configuration, or unrestricted outer-cycle creation authority. Starting reflection normally happens through `research.advance`; exposing a second unrestricted creation route adds little.

   Domain services need explicit admission for a valid research director lease. Do not delete all `!caller.session` checks, strip `caller.session`, or impersonate the owner. `research.decide` must preserve the director’s actor identity while invoking narrowly authorized domain operations through injected services.

   There is also an ownership trap. Tasks currently store their creator as `producer_id`, and work delegation checks that identity or administrative authority. A retired director actor is unsuitable as the only administrative owner. New children should retain the stable cycle owner for administration and the director actor for authorship and review exclusion. Experiments already distinguish `owner_id` and `created_by`; tasks need the equivalent distinction or an explicit admission rule using durable coordination provenance. [Task creation and ownership](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/tasks/src/index.ts:335)

   Use a new `research.direct@1` context recipe containing:

   - The immutable mandate and exact adopted paper revision.
   - Remaining allowances, reservations, deadlines, and allowed decision kinds.
   - Current stage, selected work, failed prerequisites, and outstanding reviews.
   - The preceding decision and changes relevant to it.
   - An index of relevant sibling tasks, deliveries, experiments, and reviews—not merely the selected dependency list.
   - Required decision output: evidence inspected, alternatives considered, expected information gained, bounded next action, and stop/reconsideration condition.

   Freeze this packet at offer. Let the director read further evidence freely. Require exact revisions for objects its decision will mutate; do not invalidate a decision merely because an unrelated project event occurred.

   **Independence must include intellectual direction.** Preserve existing producer and delegation-source exclusions, and additionally exclude the director actors that commissioned or materially revised the work. The runner’s credential source and the author of the research direction are not necessarily the same actor. Fresh sessions must not erase that provenance.

   I would independently review the initial operational definition and the final goal assessment, using existing task/reflection review machinery. Routine bounded commissioning need not acquire a new approval workflow: experiment design review already checks the proposed science. The director may propose decisions; it may consume approved findings; it never supplies the approval.

2. **Dispatch on decision-relevant change, with bounded timer recovery.**

   Neither “every project change” nor “only when the queue is empty” is appropriate.

   Wake a director when:

   - Its cycle first needs definition or commissioning.
   - A selected prerequisite succeeds, fails, or becomes unusable.
   - A feasibility result arrives.
   - A stage handoff becomes available.
   - A relevant review or approved reflection changes the next decision.
   - An effort threshold or recorded reconsideration deadline is reached.

   Ignore heartbeats, reads, tool observations, and the director’s own bookkeeping. Coalesce multiple relevant changes. Persist the last considered event cursor or equivalent decision-relevant state digest, plus an optional next reconsideration time. Existing runner polling can discover eligibility; no new scheduler service is necessary.

   A “wait” decision consumes the observed changes and records its wake condition. It does not immediately make itself eligible again. A slow watchdog handles missed events and stalled work, but repeated wakeups without new evidence consume a finite retry allowance.

   The current unique live-session index already excludes two leases on the same instance and revision. Keep it, and use revision CAS for committing decisions. Add a project-level invariant allowing only one active autonomous directing cycle. Otherwise two different cycles can each legally obtain a director and compete over the same project. [Session uniqueness](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/sessions/src/index.ts:149)

   A successor cycle should be created atomically with its predecessor’s continuation decision, inheriting the same mandate and counters. The director cannot obtain a fresh budget by creating another cycle.

   Prevent endless commissioning with hard limits on total admitted work, director activations, attempts, and elapsed duration. Concurrency limits alone do not do this: the existing seven-active-experiment limit still permits an unlimited sequence of experiments. Nor does the current 30-second failure backoff bound retries across time or runners. [Dispatch backoff](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/sessions/src/dispatch.ts:688)

3. **Separate “finished answering” from “stopped spending.”**

   The smallest honest completion record is an independently checked disposition of the original goals:

   - Answered, including a supported negative answer.
   - Unresolved, with the limitation and remaining uncertainty stated.
   - Outside the originally authorized scope.

   “Done” requires the mandate’s completion conditions, supported by exact reviewed evidence, plus any required consolidation. An empty dispatch queue and a `complete` cycle are insufficient: today those principally describe procedural completion.

   Put the goal assessment in the final reflection submission and its review criteria. The director can request completion only against that exact approved assessment. Replanning away a failed experiment must not remove its associated goal from this assessment. Required completion criteria must not be satisfied through generic review waivers.

   Record stopping separately: `budget_exhausted`, `deadline_reached`, `no_viable_next_step`, or an explicit abandonment/failure reason. This stops autonomous admission without claiming scientific success. Unfinished records remain visible; reaching a cap never synthesizes passing reviews.

   For budget, start with quantities Merv actually controls:

   - Total session offers, including director and review retries.
   - A maximum duration per session and an overall run deadline.
   - Total commissioned work and experiment attempts.

   Charge or reserve at admission, transactionally, across all runners and both automatic and explicit session offers. A limit checked only in the runner or only in `research.decide` is bypassable. Conservative accounting that charges an interrupted offer is acceptable if named honestly.

   Keep a small, explicit allowance for final reporting and cleanup. Exhaustion must trigger server-side admission refusal even if the director never runs again. Sessions already have hard deadlines; clamp those against the project’s remaining authorization.

   Call this an **effort allowance**, not dollars. The “token” observations currently estimate serialized tool payload size; they are explicitly not model usage or billing. [Observation accounting](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/sessions/src/observations.ts:5)

   A financial or GPU-hour guarantee requires the execution provider to enforce reservations and limits. Ending a Merv session does not prove an external training job stopped. Until that integration exists, retain the sandbox service’s cap and report external spend as unknown rather than inferred.

4. **Make feasibility a reviewed prerequisite before admitting bulk work.**

   The wrong-regime failure is an information-ordering problem. Reflection discovered evidence that should have constrained the first expensive admission.

   Use an ordinary, small task for calibration or feasibility, with independent task review. Its brief should require:

   - Reading the relevant sibling deliveries and prior runs.
   - Checking that the proposed regime can expose the hypothesized effect.
   - A positive control or another demonstrated sensitivity check.
   - Evidence that the metric distinguishes the alternatives at the proposed scale.
   - A bounded pilot, with explicit stop conditions and retained raw outputs.
   - A recommendation identifying the exact configuration range for which bulk execution is justified.

   Then require bulk experiments to name an approved feasibility result applicable to their actual design. A task being `done` is insufficient: a correctly completed feasibility task may conclude “do not proceed.” Admission needs the reviewed disposition and scope, not just dependency success.

   The director commissions this task and uses its result. The experiment design reviewer verifies applicability. The server enforces the dependency and approval requirement. These are complementary responsibilities.

   This needs a small program change and recipe changes, but no new general workflow state machine. Existing experiment planning already waits on prerequisites. Publish `experiment@5` and `@6` for non-Git and Git work, with explicit feasibility admission checks and version-7 recipes for affected stages. Preserve versions 1–4 unchanged. [Experiment program](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/experiments/src/program.ts:997)

   Do not commission an entire bulk grid speculatively behind an ambiguous pilot. First obtain feasibility evidence, then admit a small tranche. Recheck when configuration changes invalidate the evidence.

   A recipe alone cannot guarantee cheap execution. Pilot workers also need provider-enforced resource limits; otherwise an ostensibly cheap task can launch the same expensive grid through an auxiliary service.

5. **Let reflection block adoption of its conclusions, not unrelated work creation.**

   Publish `reflection@3` without `blocksStarts: ['task', 'experiment']`. Continue permitting bounded research under the last accepted mandate and approved evidence.

   While a reflection is unapproved, block:

   - Applying its proposed paper changes.
   - Consolidation that claims its change specification as approved authority.
   - Treating its proposed scope changes or conclusions as established.
   - Completion claims that depend on its assessment.

   Much of this boundary already exists: reflection paper edits are accepted in the review transaction, and research checks `reflections.approved` before its consolidation handoff.

   Give each synthesis submission a frozen coverage manifest: exact evidence IDs, relevant record revisions, and what remained unfinished when it was submitted. Reviews approve that submission and coverage. They need not certify an indefinitely moving “current project.”

   Research may keep changing while the wave runs. New evidence can motivate a return to synthesis or a subsequent wave, but it should not silently enlarge an already submitted review’s obligations. Paper revision conflicts require rebasing and re-reviewing the changed proposal.

   Preserve the five independent lenses and substantive corrections. Three rounds catching real errors are useful; globally freezing commissioning is the avoidable cost. Bound the rounds through the effort allowance, and stop with an unresolved reflection if it cannot converge.

   Publish `reflection.lens@3` as well if retaining the current parent-version-to-lens-version mapping, and publish `reflection.{lens,synthesis,review}@5` recipes. Make recipe selection version-aware: the current lookup selects a recipe by name alone. Keep v2 and its recipes registered for existing instances.

6. **Assume the director will sometimes make bad decisions.**

   | Failure | Cheapest effective guard |
   |---|---|
   | It invents a convenient goal or weakens success criteria | Fixed mandate; independently reviewed definition; no director authority to revise the mandate. |
   | It repeatedly creates plausible but redundant work | Small batch limit, total creation allowance, prior-decision context, and required evidence/novelty rationale. |
   | It ignores evidence buried in another task | Relevant sibling-delivery index in context; explicit evidence citations; reviewed feasibility prerequisite. |
   | It drops failures to make the project look successful | Immutable selection history and final assessment against original goals, including excluded work. |
   | It kills useful work on a stale observation | Target-revision checks and cycle ownership checks; narrowly permitted termination reasons. |
   | It ends unrelated project work | Durable membership/provenance checks, not merely project-wide write permission. |
   | It reviews work it directed under another session | Durable directing-actor exclusions, retained across retries and persistent-agent context resets. |
   | It crashes after partial commissioning | One transactional decision handoff and durable replay receipt. |
   | It loops on infrastructure failure or review rejection | Total retry/session limits across runners; explicit stopped outcome. |
   | It claims the project is done because everything is green | Independently reviewed goal disposition, separate from workflow terminal states. |
   | It reaches external compute through a broad credential | Merv-only director launch; provider-scoped budgets for execution workers. |
   | A rollout changes an old fingerprint | New versions, preserved registrations, production-fingerprint and restart tests. |

   The launch restriction deserves explicit implementation. Claude currently forwards configured auxiliary MCP servers to every non-read-only session. A director with `workspace: none` would still receive them. Restrict director launches to Merv; workspace mode is not an external authority boundary. [Claude launch configuration](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/runner/src/profiles.ts:355)

The implementation order I would choose is:

| Priority | Change | Packages and versions | Value relative to risk |
|---|---|---|---|
| 1 | Make project reads genuinely reachable; add reviewed feasibility admission | `runner`, `api` read metadata as needed, `experiments`, task recipes; experiment **5/6**, affected recipes **7**, feasibility task recipe **1** | Directly addresses expensive scientifically useless waves. |
| 2 | Enforce effort, deadline, and retry limits | `research` owns authorization; `sessions` enforces offers and deadlines; `runner` retains deadline enforcement | Necessary before enabling autonomous commissioning. |
| 3 | Add bounded director decisions and durable ownership/exclusions | `research`, `tasks`, `experiments`, `paper`, `reflections`, `consolidation`, contracts/API; research **5**, director recipe **1** | Highest autonomy value; largest authorization and transaction risk. |
| 4 | Remove the reflection creation freeze and pin submission coverage | `reflections`, research handoff; reflection/lens **3**, recipes **5** | Improves throughput without weakening review. |
| 5 | Add provider reservations and reconciled monetary accounting | Provider integration and admission paths | Required for a true spend guarantee; defer claims of dollar accounting until supported. |

Keep the graph engine generic and the runner an actuator. Research owns decisions; Sessions owns execution admission; domain packages retain their scientific and authorization checks. Add dependencies through declared injections and shared contracts, not cross-package implementation imports.

The net-source-line constraint should shape these changes. Two concrete deletion opportunities are the read-reference expansion machinery superseded by open project reads, and the scripted owner orchestration in `live-scenario.ts`, which can become a smaller seed-and-observe scenario once Research carries those decisions. Removing read-reference machinery requires checking direct callers as well as API classification; it is not permission to loosen writes.

Each merge should identify its replacement and demonstrate negative net source lines. Do not fund features by retiring required historical registrations, weakening tests, or compressing code.

Finally, preserve existing definition, policy, and recipe fingerprints exactly. The fixture currently checks registered recipes differently from historical workflow policies; strengthen coverage for the old recipes that instances still need. Adding a director is also a policy change even where the state graph barely changes. [Published-policy test](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/tests/published-policies.test.ts:29)

The critical acceptance tests are concurrent director offers, lost-response commissioning replay, replacement-actor independence, prerequisite death during a decision, concurrent budget exhaustion, rejection of bulk work without applicable feasibility approval, continued commissioning during reflection review, and restart against production fingerprints. Those demonstrate that autonomy remains bounded when the model and the infrastructure both behave imperfectly.
tokens used
150,664
Merv should carry the director as an assignment on the research cycle. The existing lease, revision fence, frozen context, and independent review machinery are the right foundation. The missing pieces are a bounded decision handoff, durable ownership of commissioned work, and limits enforced outside the director’s judgment.

I would authorize autonomy against a fixed project mandate: the question, scope boundaries, acceptable evidence, and an effort allowance. The director may choose how to pursue that mandate. It cannot redefine success or replenish its allowance.

Several details in the code materially affect this design:

- Research registers versions 2–4, has action rules but no assignments, and explicitly refuses session callers in `authorize`. Adding a manifest alone will not make it executable. [ResearchService](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/research/src/index.ts:349)
- A worker’s own revision-changing operation is its handoff. A director cannot replan its cycle and then keep operating under the old lease. [Session handoff](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/sessions/src/index.ts:534)
- The reflection freeze is not a consistency boundary: v2 blocks new tasks and experiments, while its assignments explicitly read changing live research and embed no corpus. [Reflection definition](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/reflections/src/definitions.ts:30), [reflection inputs](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/reflections/src/index.ts:521)
- Server reads are open, but the Codex launcher still sets `enabled_tools` from the fixed manifest. That can hide the very project reads the preamble tells workers to perform. [Codex launch](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/runner/src/profiles.ts:331)

1. **Give the director one bounded decision per assignment.**

   Publish `research@5`, with director assignments on `defining`, `researching`, `reflecting`, and `consolidating`. Their admission must be independent of advance readiness. In particular, do **not** set `requiresDependencies: true`: failed or unfinished prerequisites are often precisely why the director is needed.

   I recommend one new domain command, `research.decide`, bound to the assigned `researchId` and `expectedRevision`. It accepts a small, closed decision schema:

   | Decision | Effect |
   |---|---|
   | Define | Adopt an exact reviewed problem/scope/goals/constraints proposal. |
   | Commission | Create a bounded batch of tasks or experiments and update the cycle’s selection. |
   | Resolve | End identified, cycle-owned work and reselect dependencies, retaining reasons and evidence. |
   | Advance | Perform the existing guarded stage handoff, including reflection or consolidation creation. |
   | Wait | Record what event or deadline warrants reconsideration. |
   | Finish or continue | End the authorized run, or create exactly one successor cycle within the same mandate and remaining allowance. |

   This is a research command, not a generic batch-tool interpreter. No arbitrary tool names, caller identities, SQL, or workflow transitions belong in its input.

   Validate the decision and apply its domain operations in one transaction. Record its evidence basis, created IDs, changes to selection, and rationale. A same-state decision edge advances the cycle revision and closes the lease even when the decision is “wait.” Stable command replay prevents a lost response from commissioning the batch twice.

   This atomic boundary matters: separate `task.create`, `experiment.create`, and `research.replan` calls otherwise leave partially commissioned work after a crash. Existing replay keys include the actor, so a replacement director actor does not automatically deduplicate its predecessor’s intentions.

   The director’s execution policy should contain:

   - `readOnly: false`, because it changes coordination records.
   - `workspace: { mode: 'none' }`.
   - `research.decide`, with target bindings for cycle and revision.
   - `artifact.create`, if the decision needs retained proposals or supporting analysis.
   - Its own assignment and status reads. All genuine project reads remain available independently of write grants.

   It must receive no review submission, experiment delivery, reflection synthesis, claim acceptance, Git publication, identity administration, runner configuration, or unrestricted outer-cycle creation authority. Starting reflection normally happens through `research.advance`; exposing a second unrestricted creation route adds little.

   Domain services need explicit admission for a valid research director lease. Do not delete all `!caller.session` checks, strip `caller.session`, or impersonate the owner. `research.decide` must preserve the director’s actor identity while invoking narrowly authorized domain operations through injected services.

   There is also an ownership trap. Tasks currently store their creator as `producer_id`, and work delegation checks that identity or administrative authority. A retired director actor is unsuitable as the only administrative owner. New children should retain the stable cycle owner for administration and the director actor for authorship and review exclusion. Experiments already distinguish `owner_id` and `created_by`; tasks need the equivalent distinction or an explicit admission rule using durable coordination provenance. [Task creation and ownership](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/tasks/src/index.ts:335)

   Use a new `research.direct@1` context recipe containing:

   - The immutable mandate and exact adopted paper revision.
   - Remaining allowances, reservations, deadlines, and allowed decision kinds.
   - Current stage, selected work, failed prerequisites, and outstanding reviews.
   - The preceding decision and changes relevant to it.
   - An index of relevant sibling tasks, deliveries, experiments, and reviews—not merely the selected dependency list.
   - Required decision output: evidence inspected, alternatives considered, expected information gained, bounded next action, and stop/reconsideration condition.

   Freeze this packet at offer. Let the director read further evidence freely. Require exact revisions for objects its decision will mutate; do not invalidate a decision merely because an unrelated project event occurred.

   **Independence must include intellectual direction.** Preserve existing producer and delegation-source exclusions, and additionally exclude the director actors that commissioned or materially revised the work. The runner’s credential source and the author of the research direction are not necessarily the same actor. Fresh sessions must not erase that provenance.

   I would independently review the initial operational definition and the final goal assessment, using existing task/reflection review machinery. Routine bounded commissioning need not acquire a new approval workflow: experiment design review already checks the proposed science. The director may propose decisions; it may consume approved findings; it never supplies the approval.

2. **Dispatch on decision-relevant change, with bounded timer recovery.**

   Neither “every project change” nor “only when the queue is empty” is appropriate.

   Wake a director when:

   - Its cycle first needs definition or commissioning.
   - A selected prerequisite succeeds, fails, or becomes unusable.
   - A feasibility result arrives.
   - A stage handoff becomes available.
   - A relevant review or approved reflection changes the next decision.
   - An effort threshold or recorded reconsideration deadline is reached.

   Ignore heartbeats, reads, tool observations, and the director’s own bookkeeping. Coalesce multiple relevant changes. Persist the last considered event cursor or equivalent decision-relevant state digest, plus an optional next reconsideration time. Existing runner polling can discover eligibility; no new scheduler service is necessary.

   A “wait” decision consumes the observed changes and records its wake condition. It does not immediately make itself eligible again. A slow watchdog handles missed events and stalled work, but repeated wakeups without new evidence consume a finite retry allowance.

   The current unique live-session index already excludes two leases on the same instance and revision. Keep it, and use revision CAS for committing decisions. Add a project-level invariant allowing only one active autonomous directing cycle. Otherwise two different cycles can each legally obtain a director and compete over the same project. [Session uniqueness](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/sessions/src/index.ts:149)

   A successor cycle should be created atomically with its predecessor’s continuation decision, inheriting the same mandate and counters. The director cannot obtain a fresh budget by creating another cycle.

   Prevent endless commissioning with hard limits on total admitted work, director activations, attempts, and elapsed duration. Concurrency limits alone do not do this: the existing seven-active-experiment limit still permits an unlimited sequence of experiments. Nor does the current 30-second failure backoff bound retries across time or runners. [Dispatch backoff](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/sessions/src/dispatch.ts:688)

3. **Separate “finished answering” from “stopped spending.”**

   The smallest honest completion record is an independently checked disposition of the original goals:

   - Answered, including a supported negative answer.
   - Unresolved, with the limitation and remaining uncertainty stated.
   - Outside the originally authorized scope.

   “Done” requires the mandate’s completion conditions, supported by exact reviewed evidence, plus any required consolidation. An empty dispatch queue and a `complete` cycle are insufficient: today those principally describe procedural completion.

   Put the goal assessment in the final reflection submission and its review criteria. The director can request completion only against that exact approved assessment. Replanning away a failed experiment must not remove its associated goal from this assessment. Required completion criteria must not be satisfied through generic review waivers.

   Record stopping separately: `budget_exhausted`, `deadline_reached`, `no_viable_next_step`, or an explicit abandonment/failure reason. This stops autonomous admission without claiming scientific success. Unfinished records remain visible; reaching a cap never synthesizes passing reviews.

   For budget, start with quantities Merv actually controls:

   - Total session offers, including director and review retries.
   - A maximum duration per session and an overall run deadline.
   - Total commissioned work and experiment attempts.

   Charge or reserve at admission, transactionally, across all runners and both automatic and explicit session offers. A limit checked only in the runner or only in `research.decide` is bypassable. Conservative accounting that charges an interrupted offer is acceptable if named honestly.

   Keep a small, explicit allowance for final reporting and cleanup. Exhaustion must trigger server-side admission refusal even if the director never runs again. Sessions already have hard deadlines; clamp those against the project’s remaining authorization.

   Call this an **effort allowance**, not dollars. The “token” observations currently estimate serialized tool payload size; they are explicitly not model usage or billing. [Observation accounting](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/sessions/src/observations.ts:5)

   A financial or GPU-hour guarantee requires the execution provider to enforce reservations and limits. Ending a Merv session does not prove an external training job stopped. Until that integration exists, retain the sandbox service’s cap and report external spend as unknown rather than inferred.

4. **Make feasibility a reviewed prerequisite before admitting bulk work.**

   The wrong-regime failure is an information-ordering problem. Reflection discovered evidence that should have constrained the first expensive admission.

   Use an ordinary, small task for calibration or feasibility, with independent task review. Its brief should require:

   - Reading the relevant sibling deliveries and prior runs.
   - Checking that the proposed regime can expose the hypothesized effect.
   - A positive control or another demonstrated sensitivity check.
   - Evidence that the metric distinguishes the alternatives at the proposed scale.
   - A bounded pilot, with explicit stop conditions and retained raw outputs.
   - A recommendation identifying the exact configuration range for which bulk execution is justified.

   Then require bulk experiments to name an approved feasibility result applicable to their actual design. A task being `done` is insufficient: a correctly completed feasibility task may conclude “do not proceed.” Admission needs the reviewed disposition and scope, not just dependency success.

   The director commissions this task and uses its result. The experiment design reviewer verifies applicability. The server enforces the dependency and approval requirement. These are complementary responsibilities.

   This needs a small program change and recipe changes, but no new general workflow state machine. Existing experiment planning already waits on prerequisites. Publish `experiment@5` and `@6` for non-Git and Git work, with explicit feasibility admission checks and version-7 recipes for affected stages. Preserve versions 1–4 unchanged. [Experiment program](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/experiments/src/program.ts:997)

   Do not commission an entire bulk grid speculatively behind an ambiguous pilot. First obtain feasibility evidence, then admit a small tranche. Recheck when configuration changes invalidate the evidence.

   A recipe alone cannot guarantee cheap execution. Pilot workers also need provider-enforced resource limits; otherwise an ostensibly cheap task can launch the same expensive grid through an auxiliary service.

5. **Let reflection block adoption of its conclusions, not unrelated work creation.**

   Publish `reflection@3` without `blocksStarts: ['task', 'experiment']`. Continue permitting bounded research under the last accepted mandate and approved evidence.

   While a reflection is unapproved, block:

   - Applying its proposed paper changes.
   - Consolidation that claims its change specification as approved authority.
   - Treating its proposed scope changes or conclusions as established.
   - Completion claims that depend on its assessment.

   Much of this boundary already exists: reflection paper edits are accepted in the review transaction, and research checks `reflections.approved` before its consolidation handoff.

   Give each synthesis submission a frozen coverage manifest: exact evidence IDs, relevant record revisions, and what remained unfinished when it was submitted. Reviews approve that submission and coverage. They need not certify an indefinitely moving “current project.”

   Research may keep changing while the wave runs. New evidence can motivate a return to synthesis or a subsequent wave, but it should not silently enlarge an already submitted review’s obligations. Paper revision conflicts require rebasing and re-reviewing the changed proposal.

   Preserve the five independent lenses and substantive corrections. Three rounds catching real errors are useful; globally freezing commissioning is the avoidable cost. Bound the rounds through the effort allowance, and stop with an unresolved reflection if it cannot converge.

   Publish `reflection.lens@3` as well if retaining the current parent-version-to-lens-version mapping, and publish `reflection.{lens,synthesis,review}@5` recipes. Make recipe selection version-aware: the current lookup selects a recipe by name alone. Keep v2 and its recipes registered for existing instances.

6. **Assume the director will sometimes make bad decisions.**

   | Failure | Cheapest effective guard |
   |---|---|
   | It invents a convenient goal or weakens success criteria | Fixed mandate; independently reviewed definition; no director authority to revise the mandate. |
   | It repeatedly creates plausible but redundant work | Small batch limit, total creation allowance, prior-decision context, and required evidence/novelty rationale. |
   | It ignores evidence buried in another task | Relevant sibling-delivery index in context; explicit evidence citations; reviewed feasibility prerequisite. |
   | It drops failures to make the project look successful | Immutable selection history and final assessment against original goals, including excluded work. |
   | It kills useful work on a stale observation | Target-revision checks and cycle ownership checks; narrowly permitted termination reasons. |
   | It ends unrelated project work | Durable membership/provenance checks, not merely project-wide write permission. |
   | It reviews work it directed under another session | Durable directing-actor exclusions, retained across retries and persistent-agent context resets. |
   | It crashes after partial commissioning | One transactional decision handoff and durable replay receipt. |
   | It loops on infrastructure failure or review rejection | Total retry/session limits across runners; explicit stopped outcome. |
   | It claims the project is done because everything is green | Independently reviewed goal disposition, separate from workflow terminal states. |
   | It reaches external compute through a broad credential | Merv-only director launch; provider-scoped budgets for execution workers. |
   | A rollout changes an old fingerprint | New versions, preserved registrations, production-fingerprint and restart tests. |

   The launch restriction deserves explicit implementation. Claude currently forwards configured auxiliary MCP servers to every non-read-only session. A director with `workspace: none` would still receive them. Restrict director launches to Merv; workspace mode is not an external authority boundary. [Claude launch configuration](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/packages/runner/src/profiles.ts:355)

The implementation order I would choose is:

| Priority | Change | Packages and versions | Value relative to risk |
|---|---|---|---|
| 1 | Make project reads genuinely reachable; add reviewed feasibility admission | `runner`, `api` read metadata as needed, `experiments`, task recipes; experiment **5/6**, affected recipes **7**, feasibility task recipe **1** | Directly addresses expensive scientifically useless waves. |
| 2 | Enforce effort, deadline, and retry limits | `research` owns authorization; `sessions` enforces offers and deadlines; `runner` retains deadline enforcement | Necessary before enabling autonomous commissioning. |
| 3 | Add bounded director decisions and durable ownership/exclusions | `research`, `tasks`, `experiments`, `paper`, `reflections`, `consolidation`, contracts/API; research **5**, director recipe **1** | Highest autonomy value; largest authorization and transaction risk. |
| 4 | Remove the reflection creation freeze and pin submission coverage | `reflections`, research handoff; reflection/lens **3**, recipes **5** | Improves throughput without weakening review. |
| 5 | Add provider reservations and reconciled monetary accounting | Provider integration and admission paths | Required for a true spend guarantee; defer claims of dollar accounting until supported. |

Keep the graph engine generic and the runner an actuator. Research owns decisions; Sessions owns execution admission; domain packages retain their scientific and authorization checks. Add dependencies through declared injections and shared contracts, not cross-package implementation imports.

The net-source-line constraint should shape these changes. Two concrete deletion opportunities are the read-reference expansion machinery superseded by open project reads, and the scripted owner orchestration in `live-scenario.ts`, which can become a smaller seed-and-observe scenario once Research carries those decisions. Removing read-reference machinery requires checking direct callers as well as API classification; it is not permission to loosen writes.

Each merge should identify its replacement and demonstrate negative net source lines. Do not fund features by retiring required historical registrations, weakening tests, or compressing code.

Finally, preserve existing definition, policy, and recipe fingerprints exactly. The fixture currently checks registered recipes differently from historical workflow policies; strengthen coverage for the old recipes that instances still need. Adding a director is also a policy change even where the state graph barely changes. [Published-policy test](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/tests/published-policies.test.ts:29)

The critical acceptance tests are concurrent director offers, lost-response commissioning replay, replacement-actor independence, prerequisite death during a decision, concurrent budget exhaustion, rejection of bulk work without applicable feasibility approval, continued commissioning during reflection review, and restart against production fingerprints. Those demonstrate that autonomy remains bounded when the model and the infrastructure both behave imperfectly.
