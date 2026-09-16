# Reviewed code publication: ordered integration

Live checkpoints are the prerequisite, not completion of Python consolidation parity. Finish and verify each step before adding the next.

1. **Live checkpoint:** an active worker receives an immutable commit receipt through Code while retaining its original identity. The existing Runner owns fixed Git execution and recovery. Integrate tools, HTTP, UI and independent review of an exact receipt.
2. **Immutable proposal substrate:** Code seals a manifest naming the exact checkpoint, authored evidence, runner/repository identity and workflow revision. Shared `review.submit` dispatches to the domain owner. These services are implemented and integrated through a synthetic program; they do not create a production consolidation workflow. See [Code proposals](CODE_PROPOSALS.md).
3. **Complete experiment workflow:** implement the actual records, approved design, running attempt, immutable results and evidence, independent review, and distinct return-to-design versus return-to-running paths. Integrate guidance, assignments, context, tools and UI before moving on. See the [research program sequence](RESEARCH_PROGRAM_PARITY_PLAN.md).
4. **Reflection and consolidation domain:** freeze the complete research corpus, produce and approve research outputs, then seal a code proposal with exact source captures and a decision for every experiment. The reflection domain owns proposal replacement, current review and rejection back to consolidation. Its transaction creates the Code manifest, independent review and transition together. Reviewers need guaranteed access to the exact repository objects before taking an assignment.
5. **Reviewed publication intent:** after a matching independent verdict, persist the exact proposal/review hashes, repository authority, expected central OID, target OID, required source captures and ownership generation. An outstanding or completed attempt cannot silently follow a new proposal revision.
6. **Local publication:** the designated repository Runner checks ancestry and performs expected-head compare-and-swap plus a unique operation receipt in one Git ref transaction. It reports the bound fact durably before any domain publication. Lost replies recover the exact receipt; ambiguous execution is never repeated against a different target.
7. **Domain publication:** consume that bound receipt transactionally to publish the approved program outcome, including the project graph, research outputs, planned work and dependencies. A generic successful Git operation does not implement these research semantics.

The Python audit established this ordering: consolidation belongs to an approved
reflection and its frozen experiment corpus. Building publication first would
require invented domain records or omit its central acceptance rules. Keep the
Code infrastructure independent while implementing the actual research domain
before publication authorization.

## Python behavior to preserve

The Python reference checks cover immutable proposals, independent review, source decisions and publication state. The bounded audit executed 26 focused tests; evidence is retained in `/private/tmp/merv-publication-reference-tests.log`.

Consolidation source decisions cover every terminal experiment in the wave's frozen creation-time corpus, including unsuccessful, abandoned and previously considered experiments. Tasks are not experiment decision subjects. Used/adapted decisions name a source capture and integration method; reviewed-but-unused decisions specify no integration; superseded decisions name another experiment in the same corpus. Freeze the complete corpus and exact source capture identities atomically instead of rereading mutable latest heads later.

An initial consolidation has no previous `code` reference. Supply an explicit initial base in its versioned policy. Keep the TypeScript workspace rule that an absent `reference:code` fails; do not add implicit fallback to central.

The consolidator starts from its declared proposal base, and the reviewer inspects its exact proposal head. Publication authorization belongs to the authenticated source that owns the attempt, not merely a caller-supplied runner label. Session credentials cannot use publication control routes.

The publication receipt must describe the exact expected and target OIDs, parents, statistics, required source identities and ancestry checks. Cherry-pick or rewrite need not preserve source ancestry; merge/fast-forward claims must. Record the bound Git fact before separately retrying domain materialization. A bound result cannot be abandoned as if the Git side effect never happened.

## Regression to avoid copying

The local audit reproduced a Python race: an old attempt marked stale can accept a delayed target receipt after a newer proposal revision exists and become bound again. The probe and output are `/private/tmp/merv-stale-publication-probe.py` and `/private/tmp/merv-stale-publication-probe.log`.

In TypeScript, stale/cancelled/superseded attempt states must remain terminal. Reconciliation may retain an orphaned observation for diagnosis, but it must not revive authorization or publish another revision. Exact proposal, review, repository, attempt and owner-generation checks belong in the same transaction as accepting the bound receipt.

## Open architecture requirement

Today's `refs/merv/central` belongs to one machine's private repository. Before treating it as a project-wide central head, designate repository authority and define object availability across runners. Same-machine tests cannot establish cross-machine transport or server-side Git verification. Preserve this limit in UI and API wording until the actual authority and transport are integrated.
