# Research optional-stage design review — Claude Fable, 2026-09-16

**Conditional design endorsement; no implementation approval.** The actual reviewer was `claude-fable-5`, high effort, one turn, no tools/web requests or fallback. It reviewed only the new 4,632-byte source-free design brief, SHA-256 `1a564378379c796029ac3bda99d76cc3297a55af6d75fd81f87093f59e271795`, and the same fixed 167-byte design-review system prompt. See [provenance](research-optional-design-fable-20260916-provenance.json).

This review addresses the user's newer requirement that Research survive removal of optional stage plugins. It is separate from the [previous dependency design judgment](dependency-ui-fable-20260916.md), which assessed the earlier required-edge behavior, and from the [frozen-source readiness review](production-readiness-fable-final-v2-20260916.md). No code or test result for this change was sent to Fable.

## Local disposition and verification required

Fable endorsed State/Scope/Workflows as Research's mandatory core, four optional bindings, provider-specific blockers, and per-used-binding validation. It identified four concrete review targets: receipts replay without live providers; complete snapshot handoffs without a snapshot/live evidence mixture; validation of every used binding in a multi-provider operation; and preservation of durable wave approvals and child references through unload/rebind.

Two cautions should be applied within the existing architecture. Durable domain records must survive plugin removal in State; this does not require moving Reflections or Consolidation's domain ownership into Workflows. In-flight operations require a documented withdrawal/drain or cancellation policy and stale-binding rollback; the brief-only review does not establish that a new cancellation framework is needed. No provider may commit external effects that the caller incorrectly assumes SQL rollback can undo.

Load-optional does not mean an unfinished scientific stage can be skipped. Existing stage requirements remain visible blockers. Readers should preserve recorded child IDs and distinguish unavailable detail from no records. Tests must exercise removal/replacement while awaiting, both bindings in a live evidence handoff, v2/v3 historical read/replay with optional providers absent, and persisted reflection work across removal/re-addition.

These are implementation acceptance targets, not reported passing results. No implementation was changed by this review task.

## Fable response — verbatim

# Design Review: Research Resilience to Optional Plugin Removal

## 1. Coherence of the ownership/lifecycle split

The split is coherent for the stated requirement, with one important semantic clarification and two residual coupling risks.

**Clarification needed:** "Optional" here means *load-optional*, not *workflow-optional*. Paper is still a hard prerequisite for defining→researching; Reflections for reaching completion. That is acceptable — the requirement was "the overall process still has to function," and per-action blockers satisfy that — but the plan should state explicitly that a new cycle with Paper unloaded parks at `defining` with a named blocker rather than "functioning." If the user expects forward progress without Paper, this design does not deliver it, and that should be surfaced now, not at rollout.

**Residual coupling risk A — data ownership.** The plan says "core existing lens work and retained evidence remain independent" of Knowledge, but is silent on where reflection/consolidation *artifacts durably live*. If approved reflections or lens-wave state are stored inside the Reflections plugin rather than in the mandatory State service, unloading Reflections mid-wave loses approval evidence — contradicting "already promised work is not silently completed" and its inverse (not silently lost). Rule to make explicit: **optional plugins contribute behavior; all durable workflow-relevant artifacts live in mandatory State/Workflows.**

**Residual coupling risk B — replay.** Replay of recorded commands must replay *receipts*, not re-invoke providers. If replaying a v2 cycle that touched Knowledge demands a live Knowledge binding, replay is silently coupled to optional plugins and historical reads break on removal. The plan lists "persisted historical graphs" as a test but doesn't state the replay-from-receipts rule; state it.

## 2. Stage dependencies, fences, evidence authority

**Ambiguous conditional on reflecting→consolidating.** "Requires Consolidation and Knowledge *if it must gather live research evidence IDs*" — who decides "must"? Define the decision procedure: (a) snapshot exists and is complete → snapshot path, no Knowledge; (b) no snapshot, Knowledge absent → block with named Knowledge blocker; (c) partial snapshot → block, never mix snapshot and live evidence in one handoff. Case (c) is unaddressed and is the likeliest evidence-authority regression: a partially-snapshotted cycle must not proceed with the snapshot half plus silently-empty live half.

**Multi-provider operations.** The binding-token scheme is described per-provider ("captured only when an operation actually uses that provider"). Reflecting→consolidating may use *two* optional providers. Confirm the design captures and re-checks **both** tokens before commit, and that removal of either during await rolls back atomically. As written, this is implied but not stated.

**Disposal of in-flight calls.** Checking the token before commit catches removal, but a call *into* a disposed provider must fail fast rather than hang or partially write to provider-external stores. Disposal should cancel/poison in-flight calls; the token check is the second fence, not the only one.

**Absence vs. empty in list/read paths.** The plan correctly forbids treating absence as empty evidence in transitions, but list operations are a quieter regression path: a list that silently filters unresolvable child references under-reports. Reads must distinguish "zero items" from "provider absent — N references unresolved," and the UI must render the degraded state.

**Rebind semantics.** "Rebinding restores the same capability, not stale in-flight grants" is right; also ensure any authorizations *queued but unconsumed* under the old binding are revoked at disposal, not merely fenced at next read.

## 3. Highest-value adversarial tests (using existing State/Scope/Workflows/Transaction machinery only)

1. **Mid-await unload + replace, two-binding split-read.** Start an operation that resolves an optional provider, park it on the await, unload and rebind a replacement, resume. Assert: rollback, no partial command commit, no receipt, and — critically — no single operation observed both bindings. Retry afterward must succeed cleanly against the new binding.
2. **Two-provider transition partial availability.** Begin reflecting→consolidating (live-evidence path) with Consolidation bound; unload Knowledge after the Consolidation token is captured but before evidence gathering. Assert: specific Knowledge blocker, no empty-evidence handoff, state and expected revisions unchanged.
3. **Historical read/replay with everything optional removed.** Complete a v2 and a v3 cycle normally; remove all four optional plugins; run get/list/replay. Assert: all succeed from receipts, snapshot evidence renders as recorded (marked unresolvable, never dropped, never re-fetched), no provider demanded.
4. **Reflections unload mid-five-lens wave.** Approve two lenses, unload Reflections, verify approvals and wave state survive in durable State; rebind; verify resumption without approval reset or stage skip.

These four cover the three genuinely novel failure surfaces (binding identity across awaits, partial multi-provider availability, receipt-based history) plus the data-ownership risk. No new framework is warranted; the per-provider token plus Workflows' existing revision fencing is proportionate for four bindings.

## 4. Endorsement vs. approval

**Design endorsement (conditional):** The architecture — mandatory State/Scope/Workflows core, four optional bindings, per-action provider demand, per-provider binding tokens with pre-commit checks, absence-is-not-evidence — is a sound and appropriately minimal answer to the new requirement, *conditional on* resolving the four gaps above: durable-artifact ownership outside optional plugins, replay-from-receipts, the mixed-snapshot rule, and explicit dual-token handling.

**Not implementation approval:** I have reviewed only this brief. I have not seen the code, the transaction/rollback implementation, the Workflows fencing changes, the tests, or any run results, and I cannot attest that the described guarantees hold in practice. Implementation approval should follow only after the four adversarial tests above pass and the fencing/rollback code paths are reviewed directly — in particular the disposal behavior of in-flight provider calls, which is where described designs and real async behavior most often diverge.
