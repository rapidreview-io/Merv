## Critical risks

1. **Seed-set correctness depends on workflow coverage.** Seeding removed IDs from `workflow_instances` with no `outcome` only works if *every* unfinished legacy work item has a workflow instance. Schema 81 has status columns on `projects/experiments/tasks/reflections/review_requests` independent of workflows — an in-progress experiment created outside a workflow (or whose instance was already terminal-but-work-unfinished) will be missed or wrongly retained. `outcome IS NULL` is also not the same as "unfinished": verify how failed/cancelled instances encode outcome.
2. **"Finished" is per-entity, not per-workflow.** A parent workflow with no outcome may own children that are completed entities (tasks with `outcome`, reflections with `published_at`, experiments with terminal `status`). Deleting by workflow subtree over-deletes; the plan says preserve completed children, but the derived export must then **detach** `parent_id`/`child_key` on retained `workflow_instances` rows and prune `workflow_history/workflow_actions` referencing removed instances — otherwise import-time FK/reconciliation fails.
3. **Polymorphic references are the main leak.** `submissions`, `research_artifact_links`, `paper_links`, `reviews`, `review_requests`, `events`, `research_objects`, `posts` (`ref`, `attachments_json`, `in_reply_to`, `quote_of`) all use `target_type/target_id` or free refs with no declared parents in the spec. Any missed edge → dangling reference in the pruned export or orphaned artifact deletion.
4. **Artifact retention policy inversion risk.** "Remove artifacts exclusively tied to removed work" must be computed as *retain if any retained reference exists* (links, figures, submissions, posts via `embed_sha256`/`image_sha256`/attachments, `project_candidates.expected_sha256`, litreview bodies). Content-addressed sharing (`content_sha256` dedupe in R2) means deleting bytes for one artifact ID can break a retained one — delete bytes only when no retained row references the hash.
5. **`reflection_reserved_names` / `node_dependencies` / `workspace_advances`**: `workspace_advances.instance_id` points at `reflections` (not workflow_instances) per the spec — a naming trap; pruning by workflow instance ID here would be wrong. `node_dependencies` edges to removed nodes must go both directions.
6. **Prose vs. structured links.** Correct call not to rewrite prose, but retained `posts`/`litreview_sections` will contain dead textual IDs. Accept this explicitly; do not attempt partial rewriting.
7. **Cutover ordering.** Fresh protected backup must be taken *after* writers are stopped and connections drained, before derive/prune; the export hash in the derived output must match that backup, not an earlier one. Google OAuth callback validation must gate the public route switch, not follow it.
8. **UI concern is orthogonal**: since redesigned-UI feedback is unresolved, the route switch is reversible only if the Caddy/Vercel rollback path is tested pre-cutover, not just "preserved."
9. **Old plugin 0.1.5**: agree — disable it; legacy MCP OAuth tables are already excluded, so no auth continuity exists. Communicate machine-key issuance before flip.

## Smallest correct pruning algorithm

Operate purely on the immutable projection-v2 export (snapshot hash pinned):

1. **Finished predicate per entity type** (explicit, reviewed table): e.g. task finished ⇔ terminal `status`/`outcome` present; reflection finished ⇔ `published_at` set; experiment finished ⇔ terminal `status` + `conclusion`; project retained regardless (container). Never derive finishedness from parents.
2. **Seed** R₀ = unfinished entities by predicate ∪ `workflow_instances` with no outcome (assert every recorded `workflow` type has a mapped entity predicate; fail closed on unknown types).
3. **Removal closure** (iterate to fixpoint): remove rows whose declared parent is removed; remove polymorphic rows (`submissions`, `reviews`, `review_requests`, `review_sessions`, `research_artifact_links`, `paper_links`, `events`, `research_objects`, `workflow_history/actions`, `post_reactions` via posts) whose `target_*` / `instance_id` / `submission_id` resolves to a removed row. **Exception:** never propagate removal *downward* into an entity satisfying the finished predicate — instead null/detach the parent pointer and record the detachment in the report.
4. **Artifacts last:** artifact removed ⇔ (`status` incomplete) ∨ (every referencing row across links/figures/submissions/posts/candidates is removed). Bytes deleted only when no retained row anywhere references its `content_sha256`.
5. **Emit** derived export: source snapshot hash, policy version, per-table original/removed/retained counts, removed-ID manifest, detachment list, artifact byte-deletion list. Original export byte-identical.
6. **Validate before import:** referential closure check — every FK/polymorphic reference in the retained set resolves within the retained set or is an explicitly recorded detachment. Fail the cutover on any dangling reference.

## Acceptance gates (all must pass, in order)

1. Filter reviewed + finished-predicate table signed off; run on snapshot copy; counts per table reconcile: original = removed + retained, and removed-ID manifest hash recorded.
2. Zero dangling references in retained export (automated closure check); zero finished entities in the removed set (spot-audit sample per type + automated predicate cross-check).
3. Artifact gate: every retained artifact/figure has verified bytes or explicit `metadata-only` retention; no `content_sha256` deleted that any retained row references.
4. Writers stopped, connections drained, fresh backup taken; derived export's source hash == that backup's export hash.
5. Import into new schema/prefix with distinct `sourceId`; importer counts == derived export counts, byte/hash verification passes; receipt persisted.
6. Auth: Google callback round-trip on production domain (login + session issuance) verified privately before public route; Merv machine key works against current tool registry; old plugin disabled.
7. Public Caddy route + HTTPS check green; Vercel redirects narrow; rollback path exercised (route reverted and re-applied once) before declaring done.
8. Offline legacy backups verified restorable (checksum + trial restore) — the delete authorization is only safe because of this.

One question I can't resolve from evidence: what exact terminal states count as "finished" per entity type (values of `status`/`outcome`)? That table is the whole safety of the prune and must be enumerated and reviewed explicitly before implementation.