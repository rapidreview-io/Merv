# Living research implementation

User-approved goal, 2026-09-15. The earlier parity inventory is background, not a requirement to reproduce every Python subsystem. This goal remains active until the integrated paths below are verified.

## Boundaries

- Compute and remote data/model storage belong to merv-sandboxes. Use External Mounts and its existing exact grants/credential bindings. Do not build a competing compute/storage provider.
- Keep key authentication. OAuth is explicitly deferred.
- Add artifact transfer convenience only where it avoids agent-written/base64 payloads or simplifies tool use. Reuse current artifact contracts and limits.
- Workflows remains the only workflow engine. Domain plugins register programs, recipes, checks, leases and review routes. Agent Sessions and Runner execute their assignments.
- No automatic agent identity changes or handoffs. A continuing agent explicitly acquires its next assignment.

## Implementation order and acceptance

1. **Paper:** a single living-paper provider owns structured problem definition/scope/goals/constraints, ordered literature sections and paper/citation records, and versioned Methods/Results. Edits are scoped, revision checked and replayable. Methods/Results writing is a real workflow with frozen evidence/coverage and visible freshness, rendered in the existing UI.
2. **Reflections:** a new provider owns server-captured waves, a five-lens roster with child workflows, join, synthesis and independent review. Recipe context includes the frozen research corpus and living-paper facts. Approved report/evidence is immutable and available to downstream programs. No separate scheduler or context-adapter plugins.
3. **Consolidation:** a separate ordinary workflow begins from an approved reflection and may require additional work dependencies. It retains a decision for every experiment, exact report/evidence and Code proposal when Git is involved. Independent review may return only to consolidation. A completed reviewed consolidation is not a claim that a central Git branch was advanced.
4. **Research cycle:** a small outer workflow coordinates the actual child instances and exposes blockers through existing workflow guidance. It does not duplicate their domain state or invent new scheduling/identity machinery. Child outputs feed the living paper.
5. **Integration:** default/plugin-selected application boot, API tools, UI pages, permissions, unload/reload, restart/replay and end-to-end domain tests. Browser-check the final living paper and workflow views. Regenerate architecture documentation.

The existing native calls, lifecycle tests and TypeScript checks remain regression requirements. Add targeted tests for real domain invariants rather than implementation-shaped tests. Keep network/provider verification distinct from fixture evidence; no cloud resources need provisioning for this goal.

## Starting evidence (historical)

- Starting worktree inspected: existing execution, Tasks, Experiments, Knowledge corpus capture, key identity and agent observations are present. Paper/Reflections/Consolidation providers are absent at the start of this goal slice.
- Last goal turn classified as progress: current-state audit identified concrete missing programs and the next implementation order. No active external wait or repeated blocker was established.
- Implementation is in progress; completion is not established by this plan.

## Break checkpoint — 2026-09-15

- Paper, Reflections, Consolidation and Research providers/tools/UI are wired into default composition. Architecture inventory regenerated: 56 plugins, 25 providers, 147 declared dependencies. These counts include adapters.
- Real service tests complete the entire outer cycle through five lenses, both independent reviews and both paper publications. Artifact file upload and immutable review contributor exclusions are integrated.
- Backend and browser typechecks pass; the production browser bundle builds.
- Full suite: 681 checks, 678 passed, one optional integration skipped, two integration assertions failed (public model-contract import allowance and sidebar expectations). Those expectations were corrected; complete final regression rerun is pending. Focused rerun confirmed the architectural check; further sidebar reload expectations were then corrected.
- Independent review found synthesis work could be offered to a producer whose source cannot own the ensuing review. Reflection author is fixing admission/submission consistency with a regression test. Do not declare this goal complete until fixed and verified.
- Browser acceptance is still pending. A disposable synthetic demo was started and then stopped cleanly before the break; no browser verification is claimed.
- Resume: finish the authority fix, rerun affected/full checks, browser-check the four new views including Paper mutation/retry/role paths, update final evidence and only then mark the goal complete. See REMAINING_PARITY.md for subsequent work outside this goal.

## Final acceptance — 2026-09-15

The implementation and browser acceptance are complete. The independent synthesis
authority finding is fixed and has a passing regression. The full suite passed
681 of 682 tests with zero failures and one optional Nisa integration skipped.
Backend/UI builds and typechecks pass. A real HTTP-tool fixture completed the
entire cycle, and browser checks verified edits, citations, captured sources,
both publications, reader controls and exact receipt recovery after a lost reply.
All disposable acceptance processes and tabs were stopped.

The [requirement-by-requirement acceptance record](LIVING_RESEARCH_VERIFICATION.md)
and [machine-readable evidence](../verification/living-research.json) supersede the
unfinished break checkpoint above. Future work is listed in
[Remaining parity](REMAINING_PARITY.md); it does not redefine this goal's scope.
