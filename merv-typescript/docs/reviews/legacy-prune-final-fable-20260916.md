# Final unfinished-work filter review — local disposition

The missing `lens_id` propagation and verification checks were added before the final dry run and production snapshot. A regression case proves a link to an unfinished lens is removed. All 16 deployment/import tests and the full-size immutable-snapshot dry run passed after this change. Numeric event IDs use a separate table-specific lookup; string domain IDs remain scoped as described in the review. Completed independent work and all completed file objects are retained. Dependent review/history records associated with removed unfinished work are deliberately excluded under the user-authorized cleanup policy.

The unmodified source-only Fable review follows. It is not an assertion that Fable ran tests or inspected production.

---

## Verdict: one concrete correctness gap; otherwise no remaining blockers in the reviewed code against the provided schema.

### Blocker: `lens_id` is neither propagated nor verified

`research_artifact_links` carries a `lens_id` column (per your projection schema), but `lens_id` is absent from both the propagation field list (`target_id`, `submission_id`, `artifact_id`, …) and the final verification field list. An unfinished `reflection_lens` workflow instance (state `reflecting`) is dropped as `unfinished-workflow`, and its ID lands in `removedEntities` (workflow_instances rows have `project_id`). A retained link row whose `target_id` points at a retained reflection but whose `lens_id` points at that removed lens instance would survive with a dangling structured reference — and the final fail-closed sweep would not catch it, because `lens_id` isn't in the checked list. Your dry run passing does not rule this out for the final export: the check is absent, not merely unexercised. Fix: add `'lens_id'` to both the propagation loop's field array and the verification loop's field array. If domain invariants guarantee links only exist for submitted lenses, encode that as a `check` instead — but don't leave it unchecked.

### Observations (not blockers — flagging so you can consciously accept them)

1. **Tables without `project_id` rely entirely on declared parents.** `removedRef` computes `entity(undefined, id)` for `review_sessions`, `workspace_advances`, `consolidation_decisions`, `artifact_figures`, `research_submission_artifacts`, so all field-list checks are silent no-ops there. I traced each: every one has declared parents covering its actual foreign keys (`request_id`, `instance_id`/`proposal_id`, `proposal_id`/`experiment_id`, `artifact_id`, `submission_id`/`link_id`), handled via ID-global `isRemoved`, which your B3 uniqueness check makes safe. Consistent — but any future column added to these tables must get a declared parent, since the generic sweep won't see it. `superseded_by` correctly uses `isRemoved` rather than `removedRef`, so it works despite the missing `project_id`.

2. **`removedEntities` is a cross-table namespace.** B3 enforces ID uniqueness *within* each table, but `removedEntities` mixes IDs from all tables in one set. A retained row whose `target_id` string coincidentally equals a removed row's ID from an unrelated table would be spuriously removed. With UUIDs or kind-prefixed IDs this is negligible; if any table uses short/sequential IDs, it isn't. Worth one assertion on the real export if you're unsure of ID formats.

3. **Submitted reviews under an unfinished request are removed via the `request_id`/`session_id` parent chain even when their `target_id` is retained finished work.** This matches "dependent evidence removed with the unfinished work" if you treat the request as the work unit, and likely can't occur in practice (a `started` request shouldn't have submitted reviews). The dry run removed 62 reviews vs 753 requests — plausible. Just confirm the report language covers this case, since it's evidence *about retained* work being removed.

4. **Complete figure under incomplete parent upload fails closed** (`legacy_prune_finished` throw) rather than detaching. Your test asserts this and the dry run showed 0 removed figures, so it's the correct conservative behavior for now; if the final export ever hits it, that's a deliberate manual decision, not a silent loss.

### Things I verified and found sound

- Fail-closed state machine (`finished`) covers unknown kinds/states with no override; outcome/state agreement checked both directions.
- Idempotence/derivation guards (`sourceId` distinctness, no re-derivation, snapshot hash format) are correct; source input proven unmutated in tests.
- Count reconciliation per table, deterministic double-derivation, JSON scrub verified by re-running `cleanJson` at verification time (self-consistent by construction).
- Prose retention semantics: `referenceField` regex only scrubs key-semantic fields; string mentions in `note`/`text` survive, matching tests.
- Detachment audit (before/after SHA per row) and `deletedObjectBytes: 0` invariant are structurally enforced, not just reported.
- Dry-run counts are internally consistent (e.g. 674 removed workflow instances vs 1345 removed history rows, 0 artifacts/figures removed, all 30 projects retained).

### Status

The dry run on the immutable export is evidence the filter behaves as intended on that snapshot; it is not verification of the final migration, which correctly remains gated on the fresh writer-quiescent export, byte/copy verification, and import reconciliation you described. Fix the `lens_id` gap (both loops), rerun the test suite plus the full-size dry run, and I see no other correctness blocker in this code against the provided schema.