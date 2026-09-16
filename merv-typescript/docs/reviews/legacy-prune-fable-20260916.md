# Review: prune-legacy.mjs (blockers first)

## B1 — Complete artifacts are not fail-closed against cascade removal (violates stated policy)
Only finished domain rows and four workflow kinds enter `protectedRows`. `artifacts`/`artifact_figures` rows with `status === 'complete'` are **not** protected. The recursive cascade removes any row whose `legacyHistoryTables[table].parents` entry or listed field points at removed work — and that loop runs over `artifacts` too. If the schema's `parents` for artifacts includes anything besides `project_id` (e.g., an owning instance/workspace), complete artifacts attached exclusively to unfinished work are **silently deleted**, then the `retainedIds` filter propagates the deletion into `snapshot.foundation.artifacts`, so the final reference check never fires. This directly contradicts "preserve all COMPLETE upload artifacts independently, even exclusively attached to unfinished work."

**Fix:** add every `status === 'complete'` artifact/figure key to `protectedRows` in the upload loop, so any cascade path that reaches one aborts instead of deleting. Additionally assert post-prune that the set of complete artifact IDs is unchanged from input.

## B2 — Finished reviews and reflection_lens work are deleted
- `table !== 'review_requests'` deliberately excludes finished reviews from protection, and `review_old` (status `submitted`, targeting `exp_pending`) is removed by the `target_id` cascade — the fixture asserts `review_requests.length === 0`.
- Finished `review`/`reflection_lens` workflow_instances are also unprotected and removed via `removed-dependent-workflow-parent`.

Per your own terminal map, `submitted`/`superseded` reviews and `submitted` lenses are **finished** work. Deleting them destroys completed reviewer prose — the same class of bug as the earlier wave/child warning, one level down. If "a review of deleted work is meaningless" is the intended carve-out, it must be an explicit signed-off policy line in the report (`report.policy` gives no hint); otherwise these should be retained with `target_id` detached like other structured links. **Blocker until explicitly decided; current code silently loses finished content.**

## B3 — `isRemoved` ignores project scope; inconsistent with `removedRef`
`isRemoved(table, id)` is keyed by table+ID only, while `removedRef` requires `(project_id, id)`. `isRemoved` drives both the `parents` cascade and the `consolidation_decisions.superseded_by` detach. If IDs are not globally unique across projects (the existence of `entity(project, id)` suggests they aren't), removing `X` in project A removes/detaches unrelated rows referencing an `X` in project B. Use project-scoped identity uniformly, or add a pre-pass check that no ID repeats across projects and abort otherwise.

## B4 — Final integrity check has coverage gaps; correctness rests on unverified `parents` metadata
The closing sweep checks 14 named fields but omits `instance_id`, `proposal_id`, `reflection_id`, `link_id`, `superseded_by`, `hard_stop_reflection_id`, and `event_id`. The latter three are detached, but the first four rely entirely on `legacyHistoryTables[*].parents` being complete — which this file can't verify and the fixture only exercises for a few tables. If `parents` misses one edge (e.g., `workspace_advances.proposal_id` when instance is retained), the derived snapshot ships dangling references. Add those fields to the final check (cheap, fail-closed) and also assert no retained `*_json` field survives containing a removed ID at any structural position (re-run `cleanJson` and require a no-op).

## B5 — Post/thread cascade over-deletes finished discussion
`thread_root`/`in_reply_to`/`quote_of` cascade means removing one post about unfinished work removes **every reply in the thread**, including finished-work prose ("retained verbatim" is not true for replies). If a pending experiment was announced as a thread root, the entire thread — including posts about completed results — vanishes. Decide: either detach reply pointers (keep posts, null the link, like `parent_id`) or document thread deletion explicitly. Current behavior conflicts with the prose-retention guarantee in the report.

## Bugs (non-blocking but fix before running on real data)

1. **`cleanJson` fallback type corruption:** `cleanJson(row[field], row) ?? (Array.isArray(...) ? [] : {})` — if a `*_json` field is a bare string equal to a removed ID, it becomes `{}`, not `null`. Downstream consumers expecting string/null will break. Use `null` for non-container originals.

2. **Prose false positives inside JSON:** any string **value** or object **key** exactly equal to a removed ID is stripped from `*_json`, even if it's user text (a note field containing only `"exp_pending"`). Low probability, but it contradicts "prose retained verbatim." Consider restricting value-equality stripping to fields in a known-reference allowlist rather than all positions.

3. **CLI env-var collision:** the `prune` command reads `MERV_LEGACY_SOURCE_ID` for the **derived** sourceId — the same variable `export` uses for the original. Running prune in the export shell always aborts on the `sourceId !== input.foundation.sourceId` check; worse, an operator may reuse an ID belonging to a *different* prior export (the check only compares against this input's ID). Introduce `MERV_LEGACY_DERIVED_SOURCE_ID` and, ideally, record/refuse previously seen source IDs.

4. **Derived manifest provenance is slightly misleading:** `{...manifest, ...derived.snapshot.metadata}` carries forward `postgresSnapshot`, `serverVersion`, and `sourceReadOnly: true` under the new sourceId. `metadata.derivation` disambiguates, but consumers reading only the manifest see a "captured" snapshot. Add an explicit `derivedFrom`/`kind: 'derived'` marker in the manifest itself.

5. **`report.removed` keys can be huge and contain `\0`-free `canonical` keys of full key tuples — fine — but the report also embeds every removed row *key*; verify no sensitive content sits in key columns (e.g., `path`, `child_key`) before treating the report as shareable.

6. **`finished()` on null/unknown domain statuses aborts the entire run** — correct fail-closed, but note that a single legacy row with a retired status (schema 81 history may predate the current state machines) blocks the migration with no per-row override path. Consider an explicit, hash-pinned exception file like `preexisting-artifact-audit.json`.

## Confirmed correct (no action)
- Original input untouched (`structuredClone` + test `deepEqual(source, before)`); no DB writes; `deletedObjectBytes: 0` is structural, not just reported.
- Domain/workflow mismatch (either direction) aborts via protectedRows collision or the outcome/state check — matches "mismatch aborts."
- Count reconciliation, derivation-of-derivation refusal, sourceId regex/reuse checks, and determinism (double-derive deepEqual) are sound.
- Shared artifact `link_done` retention and completed-child-of-pending-wave survival (parent detach + `data_json` cleanup) work as previously requested.
- `writePrivate` link-publish is safely idempotent; temp cleanup can't clobber a published report.

## Certification status
I cannot certify production safety: B1 and B3 depend on `legacyHistoryTables` internals (`parents`, ID uniqueness) not shown here, B2/B5 are undecided policy with silent data loss today, and tests run via tsx against `../dist` compiled modules — confirm the immutable Docker image compiles the same `@merv/contracts` `canonical` (hash/detachment determinism depends on it). Resolve B1–B4, add the missing fail-closed protections, and re-run the fixture plus a full-scale dry run diffing removed-row counts against an independently computed expected set before cutover.