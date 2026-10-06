# Paper and consolidation responsibility change — 2026-09-15

Paper is now a document/evidence store. Experiment results and reflection synthesis optionally include a JSON paper-change artifact; their existing independent review accepts the exact proposal in the same transaction as the scientific verdict. Rejections leave paper text unchanged, and concurrent edits require a refreshed proposal. No new agent, assignment, lease, workflow or context recipe is created for writing the paper.

Consolidation takes retained source artifact IDs and an explicit experiment decision scope. The originating Research workflow verifies reflection approval and passes the artifacts and durable prerequisites. Consolidation has no Reflections provider or type-contract dependency and remains usable after Reflections unloads.

| Provider | Direct requirements before → after | All required providers before → after |
| --- | --- | --- |
| Paper | 6 → 3 | 14 → 4 |
| Consolidation | 8 → 7 | 16 → 10 |

Experiments now directly requires Paper. Paper's former Knowledge edge is removed, avoiding a cycle. There remain 56 plugin entrypoints / 25 providers; direct dependency edges fall from 147 to 144. Native tools fall from 67 to 64 (66 with the UI registry). Removed tools: paper.begin_update, paper.publish, paper.cancel. The UI and interactive/static dependency maps reflect the new contracts.

## Verification

- Backend build, frontend typecheck/build: passed.
- Full regression with permitted local HTTP/IPC listeners: 683 tests, 682 passed, zero failed, one optional external-checkout test skipped.
- Exact paper proposal, author/execution, project boundary, original text, evidence pins, revision conflict, atomic multi-document rollback, transaction rollback and replay tests pass.
- Real experiment and reflection reviews accept paper changes without creating a living-paper instance; rejection preserves the proposal but leaves document text unchanged. Leased synthesis tools submit paper-change evidence through their existing assignment.
- Consolidation continues through assignment and independent review after Reflections and Knowledge unload; Paper stays active.
- Synthetic browser acceptance: 24 successful local HTTP calls create five independent lenses, submit synthesis and a two-document proposal, and pass the existing review. Both sections become reviewed revisions. The browser displays proposal provenance and reviewed edits, and successfully creates consolidation from artifact IDs and a prerequisite. Temporary browser tab and localhost server were closed.
- The existing architecture viewer at port 54396 was confirmed to serve the regenerated explorer exactly, including all 144 edges. Static renderer also checked all 144 edges (86 drawn arrows + 58 adapter edges).

## Compatibility

Changed scientific context recipes use version 2; old immutable recipes and context packages remain retained. Research now creates research@2, ending after consolidation. Stored research@1 cycles and legacy standalone writing inputs/leases remain historical and are not silently reinterpreted or auto-completed; use a new cycle with retained scientific work as explicit prerequisites. Existing paper/citation/publication history is preserved. Historical embedded consolidation reflection records normalize to their already-retained artifact inputs without calling Reflections.

Paper reads no longer compute project-wide corpus freshness or uncovered-source counts. The scientific workflow owns the decision to update the document. New manual citation evidence links use project-scoped artifact references; historical claim/experiment citation links remain readable and preservable. Scientific source/review relationships are now carried by the paper contribution itself.

This is a local implementation and verification checkpoint, not deployment or full Python feature parity.
