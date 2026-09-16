# Fable review of the generic assessment protocol

Status: **completed generic design consultation; not a source-code audit**.
The separately frozen private source packet remains unsent and pending specific
approval. This consultation sent a standalone 1,830-byte design question with no
repository files, source excerpts, project identifiers or credentials. Automatic
approval accepted the bounded design consultation. It used the requested
`claude-fable-5`, with tools disabled, no MCP servers and no session persistence.
The CLI reported the substantive model as `claude-fable-5` and a separate Haiku
helper invocation; no fallback model was substituted for the design answer.

## Provenance

- Prompt SHA-256: `bd4c8b9f2803e31e1adedc5cfd166282423d49321635f8a038590ad75537e35e`
- Response SHA-256: `ef81eb1575a2bdb93a9f70123c7853cc4357067689bd9d54f35d767eebdbf539`
- Duration: 41581 ms; one main turn; success.
- CLI reported total cost: $0.227984.
- Full local prompt and result: `/private/tmp/review-protocol-fable-design-20260915/`.

The question described immutable review inputs, numbered findings and waivers,
transactional verdicts, exact retries, versioned formats, revoked-claim recovery
and context replay. It asked for weaknesses and explicitly stated that no
implementation was being audited.

## Feedback and disposition

| Fable concern                                                                  | Source check and decision                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiver authority must be explicit; otherwise a reviewer can waive every check. | Python's task-review contract deliberately delegates waivers to the independent reviewer when the goal still holds. Retain this authority for parity. Waived is a distinct persisted finding with a required reason, and the UI now shows a waiver count beside the verdict and in review lists. Introducing protected criteria or requester-approved waivers is a future policy choice, not silently imposed here.                            |
| A frozen manifest alone does not prove byte integrity or retention.            | Current manifests include Artifact hashes and immutable metadata; Blobs reads verify content hashes. Existing tests cover corruption, project scoping, immutable artifacts and persistence across restart. No automatic artifact deletion/GC is exposed. Managed external storage durability and complete execution lineage remain larger parity work.                                                                                         |
| Reviewers need their own retained verification evidence.                       | The restored evidence JSON can retain independent observations and compact results while findings cite frozen producer artifacts. A separate reviewer-owned artifact attachment path is not implemented; it should preserve producer snapshot identity and narrowly authorize reviewer writes when added. Python parity in this slice is synopsis/findings/structured observations, not a claim of this additional binary-evidence capability. |
| Claim fencing must be checked inside the verdict transaction.                  | Reviews.checkSubmit validates current reviewer and claim inside the transaction; Tasks checks the current review and target revision, then applies verdict/transition atomically. Revocation, stale-claim and final-event rollback tests cover these invariants. Context replay itself grants no right to submit.                                                                                                                              |
| Retry identity and format compatibility must be deliberate.                    | Request format is immutable and included in version 2 snapshot identity. Submission identity includes its immutable review ID and canonical complete input; different content conflicts, while identical committed retries return the original result. An upgraded client reads the existing format and uses a new review for a changed submission rather than reinterpreting an old command.                                                  |
| Meeting individual checks is not sufficient to pass the overall goal.          | Tool and workflow instructions require overall-goal judgment. needs_changes/fail remain legal even with met checks. The structured gate cannot establish semantic truth.                                                                                                                                                                                                                                                                       |

Fable identified underspecified aspects of the abstract question, not verified
implementation defects. The dispositions above were checked locally against
source and tests. No source audit is claimed.

## Fable's design answer

This is a coherent protocol sketch — freeze-then-review, fenced claims, transactional verdicts, and idempotent retries are the right building blocks. The three most important conceptual gaps are below; each is a missing invariant, not an implementation detail.

**1. Waiver authority is undefined, which breaks the pass invariant.** "Pass requires each criterion to be met or waived" is only meaningful if the reviewer cannot be the sole waiving authority. As specified, `waived with a reason` sits alongside the reviewer's other findings, so a reviewer can pass anything by waiving every criterion with a plausible sentence. A waiver is really an amendment to the frozen acceptance criteria, and the protocol otherwise treats those as immutable — so waivers are the one hole in the freeze. Lightweight fix: a criterion may only be `waived` if the frozen request marked it waivable, or if a waiver approval from the requesting authority is recorded in the same commit transaction as the verdict. Verdict summaries should surface which criteria were waived so a "pass" with waivers is visibly different from a clean pass.

**2. Evidence provenance: an immutable manifest does not give you immutable or independent evidence.** Two gaps here. First, the manifest is frozen but nothing binds manifest entries to content — file bytes live as separate artifacts, so a cited artifact could be replaced or garbage-collected after the verdict commits, and nothing ties the evidence to the target revision (evidence generated against an older revision would still cite cleanly). Missing invariants: manifest entries should be content-addressed (digest recorded at freeze time), retention must last at least the verdict's lifetime, and evidence should carry the revision it was produced against. Second, if the manifest is frozen at request time, the reviewer can only cite submitter-supplied evidence, which is in tension with the reviewer being _independent_ — they cannot cite their own verification runs. Lightweight fix: allow a reviewer-appended evidence section, content-addressed and made immutable at submission, kept distinct from the frozen submitter manifest so provenance stays legible.

**3. Replay and retry identity: the fence must be checked inside the commit, and format must be part of command identity.** Saved context is replayed "only after current authorization and revision/claim checks" — but that check happens before the reviewer resumes work. If revocation advances the claim generation between replay and submission, nothing stated prevents a stale reviewer from committing. The single transaction covers verdict, transition, and receipt, but the missing invariant is that the claim generation is a _precondition of that transaction_, not just of replay. Without it, "revocation releases unfinished claims" and "submitted reviews remain immutable" can both be satisfied while an already-revoked review gets committed. Relatedly, the retry rule ("identical retries return the committed result; different inputs conflict") is ambiguous once two formats coexist: a legitimate retry from an upgraded client that now speaks the new format is either wrongly treated as identical (silently returning an old-format result) or wrongly rejected as a conflict. Fix: state explicitly that the requested format is part of the command identity, and define identity over a canonical key so presentation-only differences are classified deliberately rather than accidentally.

One smaller ambiguity worth resolving in text: the criterion-level invariant is stated as necessary for pass but not sufficient — say explicitly that `pass` also requires the reviewer's overall-goal judgment to be positive, so there is no state where all criteria are met but the goal is judged failed and the verdict is still pass.

**Genuinely implementation-level concerns** that cannot be judged from this description: whether the verdict transaction is actually atomic under the chosen store, enforcement of the bounded-JSON observation limit, correctness of by-reference feedback retrieval against the context budget, and artifact-storage durability. These are execution risks, not design flaws — the design as stated is compatible with correct implementations of all of them. The three items above, by contrast, are underspecified at the protocol level and would remain flaws even in a faithful implementation.
