# Verification

The records below describe historical runs and retain their original counts.
The current domain interface has 64 tools; the browser configuration has 66 including two UI tools. The plugin network has 56 entrypoints, 25 service providers, 144 direct dependencies and 53 default configuration entries. The mount-removal scenario adds one remote tool, yielding 67 → 66 → 67. See the latest [execution checkpoint](EXECUTION_LOG.md).

## Production Experiments — 15 September 2026

Experiments now implements a real four-stage research lifecycle: planning,
independent design review, execution of the exact approved plan, and independent
results review. It owns attempts, retained evidence associations, immutable
submission rounds and deterministic metrics exhibits. Negative reviews carry
full findings and explicitly return work to planning or execution. Recovery
preserves exact prior evidence and figures while fencing retired workers.
Workflow guidance and submission use the same structural exit checks; assignment
and dispatch admission remain metadata-only.

The complete suite passes **610/610 tests**, including prepared Nisa integration,
with no failures, cancellations or skips. There are 36 new Experiment tests;
the independent combined group passes 34 tests. Backend/UI typechecks and builds,
architecture boundaries and formatting pass. Existing catalog expectations were
updated for the seven added tools; the first broad run's six failures were old
catalog counts, with no behavioral regression hidden by those changes.

Four fresh native workers completed the actual program through Sessions and
MachineRunner: **24 successful MCP calls, zero failed calls and five successful
shell calls**. The planner authored its plan; design review approved that exact
artifact. The executor ran training-only OLS against a training-mean baseline on
five fixed synthetic held-out examples, retaining actual code, stdout, result,
report and graph. The independent final reviewer read all five pinned artifacts,
recomputed all predictions/errors and MAEs (8 versus 0), and submitted a pass.
The workflow ended at revision 4 with one attempt and two sealed rounds. The
first execution clock belongs to executor activation, and the claim stayed
active with low confidence at revision 0.

The original report assembler used a raw launch ID to locate a hashed log folder
and failed after all four workers had finished. Corrected read-only verification
used the original transcripts/ledger and a disposable server copy; no agents
were rerun and original database hashes remained unchanged. Both script hashes
and the verifier hash are retained. Independent audit confirmed evidence bytes,
actual stdout, worker/source attribution and process/socket/listener cleanup.
Sandbox Python emitted retained macOS cache diagnostics while calculation commands
exited successfully; the report does not hide those diagnostics.

The built UI passed an actual browser check using a restored copy of the native
records and a synthetic reader credential: completion/guidance, exact plan and
evidence links, findings, attempts and the retained graph. Removing Experiments
withdrew its row and tools while Claims remained usable; restoration returned
the identical experiment (**46 → 39 → 46** tools). Long details now collapse so
guidance remains visible. Separate real-record SSR verifies successor attachment
attribution and the latest results review after owner closure. All temporary
browser servers and the verification tab were stopped.

The current composition has **43 plugin entrypoints, 22 providers, 95 direct
Cordis dependencies, 40 default server entries and 30 domain/API entries**.
There are 44 domain tools, or 46 with UI. Experiments has seven direct dependencies:
State, Scope, Claims, Artifacts, Workflows, Reviews and Context Builder.

This is a bounded synthetic calculation and a production lifecycle proof. It does
not establish general scientific performance or complete backend parity. Next:
authoritative corpus/capture references, actual Reflection, then reflection-owned
consolidation/publication. Storage, operational Runner, cross-machine Git and
real shared login/deployment gaps remain open.

[Implemented contract](docs/EXPERIMENTS.md) ·
[Verification](verification/experiments.json) ·
[Native evidence](verification/experiments-live.json).

Fable consultation remains pending: automatic approval review previously rejected
export of the specific private architecture payload without payload/destination
approval. No new export or retry occurred. Independent local source and execution
reviews completed separately.

## Explicit review return paths — 15 September 2026

The existing `review.submit` now accepts an optional `returnTo`. Reviews validates
and retains the selected destination with the immutable assessment; the owning
program validates the destination and commits it with its state transition and
command receipt. Tasks rejects an explicit route and keeps its established
verdict mapping. Migration preserves old responses, snapshot hashes and replay
receipts. No plugin, dependency or tool name was added.

All **574 tests pass**, with zero failures, cancellations or skips, including
prepared Nisa integration. Eight new tests cover storage/migration, replay,
owner routing, rollback, authorization, HTTP/MCP/Cordis and Task compatibility.
The combined focused run passes 30 tests; independent review passes 17.
Two adversarial input findings were fixed and retested: prototype proxies and
route getters cannot execute during validation. Backend/UI builds and typechecks
pass.

Two fresh native reviewers completed seven successful MCP calls and no failed
calls. One submitted `fail → planned`; the other submitted
`needs_changes → running`. Root inspection compared the actual transcript
arguments/results with SQLite: all three pinned artifacts were read fully before
the verdict, assessments and workflow states matched, original worker/source
attribution was retained, and two exact command receipts were saved. Both native
workers stopped, with no pending requests or owned slots; process, socket and
listener cleanup was checked.

Actual ReviewCard rendering using these saved native review records verifies the
return destinations, unchanged notes/findings and artifact links, legacy omission
and escaped prose. This is component SSR, not browser interaction. The initial
legacy-omission assertion matched reviewer prose; targeting the actual field label
fixed the verification fixture without changing the product.

The native program is a synthetic owner with seeded evidence and a seeded approved
plan. Its destinations are terminal only for the fixture. This proves the shared
return-path support, not a production Experiment lifecycle. The exact Python
Experiment reference was separately audited with 41 passing tests. Full Experiment
records, attempts, evidence gates, assignment formulas and both review stages are
the next domain slice; overall backend parity remains open.

[Return-path contract](docs/REVIEW_RETURN_PATHS.md) ·
[Python Experiment reference](docs/EXPERIMENTS_PARITY_REFERENCE.md) ·
[Verification](verification/review-returns.json) ·
[Native evidence](verification/review-returns-live.json).

Independent local review completed. Fable remains pending specific approval of
the previously rejected architecture export; no new export or retry occurred.

## Project Claims — 15 September 2026

Claims stores project-scoped research statements and their status/confidence. Its
provider depends only on State and Scope; separate Tools and UI adapters expose
`claim.create`, `claim.list`, `claim.update` and the Claims page. Claims is a fact
provider, not a workflow program. Public edits preserve statement/scope and require
the displayed revision. Exact request retries return the original receipt even
following later updates; changed input conflicts. Records, events and receipts
share one transaction, with current authority checked before replay and commit.

All **566 tests pass**, with zero failures, cancellations or skips, including
prepared Nisa integration. Thirteen Claims tests cover project/role/session bounds,
competing SQLite writers, request replay/restart, immutable storage, transactional
rollback, malformed inputs and actual MCP/Cordis provider removal/restoration.
An independent audit caught and fixed scalar-ID validation executing a supplied
getter; the regression verifies that the getter is never called.
A separate UI review fixed loss of an unresolved request after a refused retry: a
prior ambiguous outcome now keeps its original request ID until a successful
receipt resolves it. Later 403/404 responses cannot make that earlier write known.

Two fresh native agents completed nine successful MCP calls with zero failures.
The producer retried both create and update with identical receipts, and a separate
read-only worker inspected the saved claim. Independent transcript/database review
confirmed exactly one claim, two events and two receipts, correct worker/source
attribution, another project's unchanged claim and stopped workers with no owned
slots or pending requests. This synthetic program validates the interface; it does
not perform a scientific review or implement Experiments.

A previous Code-proposal authority regression accepted any exception: its nested
transaction failed before revocation, so it did not prove the final authority
check. The corrected test injects revocation within the borrowed transaction,
requires the expected authorization error, and verifies rollback. A temporary
mutant removing only the final authority checks fails that corrected test. The
historical 553-test records remain unchanged; this checkpoint supersedes that
specific weak proof. Production Code logic did not need a change.

[Claims contract](https://github.com/rapidreview-io/Merv/blob/1883f27ae6669fe255bb317011ae505bb4b04322/merv-typescript/docs/CLAIMS.md) · [Python reference](https://github.com/rapidreview-io/Merv/blob/1883f27ae6669fe255bb317011ae505bb4b04322/merv-typescript/docs/CLAIMS_PARITY_REFERENCE.md) (both removed with the claims retirement) ·
[Verification](verification/claims.json) · [Native evidence](verification/claims-live.json).
Claims-linked experiments, history UI and reviewed reflection writes remain open.
The next domain slice is the complete Experiment lifecycle, followed by corpus
references, actual Reflection, and its consolidation/publication gate.

Actual browser interaction now verifies high-confidence creation, literal HTML-like
text, retained request identity through a lost committed response and later 404,
normal edits, concurrent-edit conflicts, project draft isolation and read-only
controls. Independent request inspection confirms one claim after all three create
calls. The temporary proxy's initial Host/Origin mismatch caused the blank page;
fixing that fixture preserved the production origin guard. The final full suite
includes the UI retry fix. Backend/UI builds and typechecks pass. The browser used
locally signed synthetic identities, not a real shared-provider login.

Independent local review completed. Fable remains pending specific approval of
the previously rejected architecture export; no new export or retry occurred.

## Immutable Code proposals and domain review routing — 15 September 2026

Code now seals an immutable manifest from a successful live checkpoint, original
worker identity and verified evidence bytes, inside the admitting domain's writer
transaction. Reviews owns `review.submit` and routes it to exactly one registered
domain owner. Existing Tasks preserves its wire contract, command replay and atomic
verdict/transition. Domain removal withdraws its owner before dependent calls drain.

The suite passes **553 tests**, with no failures, cancellations or skips, including
prepared Nisa integration. Backend/UI builds and typechecks pass. Eighteen new
proposal checks and nine routing checks cover exact session/source authority,
bounded inputs, deterministic Unicode hashing, byte corruption, immutable storage,
replay/restart, rollback, missing/ambiguous owners and unload during response drain.
The real Cordis acceptance also seals through an actual MCP invocation, removes
and restores Code, and verifies unchanged proposal/manifest/UI with one event.

Two fresh native agents passed the first acceptance run: **five shell commands,
eight successful MCP calls and zero failed MCP calls**. The producer created its
own validation artifact and Code sealed the manifest; the read-only reviewer read
both pinned artifacts, verified exact bytes/HEAD/tree and submitted through the
production `review.submit` router. The synthetic program reached `done` at revision 2. The producer retried a sandbox-blocked heredoc using a direct Python command;
the actual checks then passed. This does not claim every initial shell step worked.
Independent inspection verified retained artifact bytes and raw Git object hashes,
confirmed both workers stopped, released checkout ownership, one acknowledged
command and physical ephemeral-checkout deletion. The persistent checkout remained
clean; source repository and private central stayed unchanged.

Actual CodeView SSR using authenticated HTTP data verifies four operation states
plus a sealed proposal, original producer, commit and manifest tooltips, HTML
escaping and absence of secrets. The disposable server/clients were closed and
data removed. This is component-rendering proof, not browser interaction.
The regenerated image matches 37 plugins, 20 providers and 78 dependencies:
48 arrows plus 30 adapter edges and one separately labeled HTTP connection.

[Proposal contract](docs/CODE_PROPOSALS.md) · [Verification](verification/code-proposals.json) ·
[Native evidence](verification/code-proposals-live.json) · [Research order](docs/RESEARCH_PROGRAM_PARITY_PLAN.md).
The native fixture uses a synthetic domain, one machine and actual production
services. Its small verdict handler lacks post-transition command replay; existing
Tasks replay is tested separately. Sealing replay still requires current worker
authority, and does not reopen a worker after handoff. Code trusts the authorized
Runner receipt; server-side Git verification, production research criteria,
consolidation decisions and publication remain open.

Independent local review passed. Fable was not consulted: automatic approval review
previously rejected the prepared architecture export without specific payload and
destination approval, which remains pending. No new export or retry occurred.

## Live code checkpoints — 15 September 2026

**526 tests pass**, with zero failures, cancellations or skips, including prepared
Nisa integration. Backend/UI builds and typechecks pass. Code adds a durable
session-owned checkpoint request and immutable receipt, with two agent tools,
source-authenticated HTTP controls and the Code page. The existing Runner performs
fixed Git operations without widening the worker's native sandbox permissions.

Crash/replay tests cover private operation indexes, deterministic commits, atomic
HEAD/receipt updates, permanent checkout-owner fencing, lost dispatch responses,
late completion and retaining the checkout across an acknowledgement outage and
controller restart. Independent review found and fixed the closed-session lost
dispatch gap; its regression failed before the fix and passes afterward. Cordis
unload/reload tests verify tools, controls and UI withdraw together while durable
commands, receipts and the worker lease survive.

Two fresh native agents completed a synthetic producer → independent review → done
program using actual Reviews: **six shell commands, six successful MCP calls and
zero failed calls**. The producer received a named commit while alive. The reviewer
read the immutable receipt and independently checked exact file bytes, commit,
tree and a clean read-only checkout before submitting a passing verdict. Original
worker identities own the evidence and review. The source repository and private
central ref stayed unchanged; both workers stopped, both workspace records closed,
the ephemeral checkout was deleted and no local slot remained owned.

Actual CodeView React rendering with authenticated HTTP data verifies queued,
succeeded, failed and cancelled states, full OID tooltips and HTML escaping. This
is component SSR with a substituted data hook, not browser interaction evidence.
The 37-plugin dependency image was regenerated, checked against all 77 declared
edges and visually inspected.

[Code contract](docs/CODE_OPERATIONS.md) · [Verification](verification/code-operations.json) ·
[Native evidence](verification/code-operations-live.json) · [Publication plan](docs/CODE_PUBLICATION_PLAN.md).
Production immutable proposals, reviewed central publication and cross-machine
objects remain open. The native fixture composes actual Reviews; it does not
implement the research consolidation program or expose a production `code.propose`
tool. Fable remains pending because automatic approval review rejected the prior
specific architecture-payload export without payload/destination approval. No new
export or retry occurred; independent local reviews completed.

## Git workspace handoff — 15 September 2026

**490 tests pass**, with no failures, cancellations or skips, including prepared
Nisa integration. Backend/UI builds and typechecks pass. Runner now prepares
private persistent and ephemeral checkouts, captures stopped workers' changes,
and retains checkout ownership until Sessions acknowledges an immutable result.
No new plugin, dependency edge or agent tool was added.

Actual Git/MCP tests cover lost attachment/report/closure replies and controller
restart. Native profile checks caught automatic repository skill discovery;
explicit discovered-skill exclusions now keep those instructions out of the
initial prompt. Native workers edit checkout files; Runner creates WIP commits.

Two fresh Codex agents completed a synthetic work → capture → verify → done flow:
**three shell commands and two successful MCP calls**. The verifier inspected the
exact captured commit, the source and private central ref stayed unchanged, both
workers stopped, and the ephemeral checkout was deleted. The first live attempt
found an unmanaged test-workflow permission error; the corrected managed fixture
retains explicit producer/reviewer guards. No production permission was relaxed.

The final UI correction exposes declared workspace mode before attachment. HTTP
checks and actual SessionsView component rendering verify captured, attached,
unattached, preparation-failed and scratch rows. Browser control was unavailable;
this is component rendering evidence, not a browser interaction test.

[Workspace contract](docs/WORKSPACES.md) · [Verification](verification/workspaces.json) ·
[Native evidence](verification/workspaces-live.json) · [Profile audit](docs/RUNNER_PROFILE_ISOLATION.md).
Reviewed central publication, agent Git operations, cross-machine Git transport,
operational runner controls, research programs and storage/deployment parity remain
open. Fable remains pending approval of the previously rejected specific payload;
independent local reviews completed.

## Native machine runner — 15 September 2026

**464 tests pass**, with no failures, cancellations or skips, including prepared
Nisa integration. Backend/UI typechecks and builds, formatting and the compiled
plain-Node supervisor smoke pass. Runner is an independent machine plugin with
no injected server dependencies. It adds no agent tools.

Real process tests cover lost responses, controller crash/reconnect, exclusive
ownership, process-tree stop, independent deadlines and uncertain capacity.
Strict settings/response boundaries and distinct source-versus-session failures
are verified. The CLI starts only Runner and disposes it on SIGINT/SIGTERM.

Two fresh native Codex agents completed a synthetic task and its independent
review: **two shell commands, nine successful MCP calls**, two work starts and
both local process groups confirmed stopped. This live run preceded the final
source-versus-session refusal refinement; the complete deterministic suite tests
that change. Fable remains pending specific payload approval; independent local
reviews found and verified the documented fixes.

[Runner contract](docs/MACHINE_RUNNER.md) · [Verification](verification/runner.json) ·
[Live evidence](verification/runner-live.json). Git workspaces, pairing, telemetry,
research programs and storage/deployment parity remain open.

## Automatic dispatch and workspace declarations — 15 September 2026

**425 tests pass**, with no failures, cancellations or skips, including prepared
Nisa integration. Backend/UI typechecks and builds pass. Workflows discovers
source-authorized candidates without rendering their context. Sessions adds
transactional automatic selection, runner presence/capacity, desired settings,
canonical failure backoff and default-off project controls. The optional Sessions
UI adds no agent tools.

Pause preserves existing leases; project halt disables dispatch and closes live
workers while retaining their source accounts and work. Project summaries let
operators inspect machine-key leases without gaining exact-source control or
seeing their frozen context. Counts remain correct beyond the displayed history.
Workspace declarations preserve existing policy hashes when omitted; actual
checkout provisioning is still open.

Two fresh agents completed automatically selected work with **17 successful tool
calls** across two restarts. Browser checks verified enable, pause, halt and the
unfinished task returning to the queue. Independent review found and fixed
unsupported operator candidates and runner controls changing during assignment
callbacks; eight separate probes verify complete rollback. The live agent run
preceded those last control refinements, covered by final deterministic checks.

[Verification](verification/dispatch.json) · [Live evidence](verification/dispatch-live.json) ·
[Control-plane contract](docs/RUNNER_CONTROL_PLANE.md).
Native runner launch/reconciliation, real Git workspaces, research programs and
storage/deployment parity remain open. Fable consultation remains pending the
specific architecture-payload approval recorded in the prior Sessions checkpoint.

## Session credentials and recovery — 14 September 2026

**410 tests pass**, with no failures, cancellations or skips, including prepared
Nisa integration. Backend/UI typechecks and production builds pass. Sessions now
connects workflow policy and exact domain ownership to real MCP-only credentials.
Its HTTP adapter is optional; no new agent tools were added.

Coverage includes source revocation/expiry before activation, immutable source and
assignment receipts, safe parser defaults, queued native writes, delayed mounted
calls, durable restart, exact review-claim succession and bounded successor context.
The first full run found eight outdated review-fixture migration assumptions;
the fixture now applies current migrations while preserving the explicit old-schema
case and its history/receipt assertions.

Two fresh agents under the **same source key** completed **17 successful calls**
across two server restarts. Distinct producing and reviewing workers completed the
same task with exactly two first-start events. The live run preceded final
pre-offer cleanup and invocation preparation refinements; the final deterministic
suite covers those changes.

Independent source reviews and five extra consumer race probes found no actionable
final defect. Fable consultation did not run: automatic approval review rejected
sending its specific architecture prompt, and that approval remains pending.

[Verification](verification/sessions.json) · [Live evidence](verification/sessions-live.json) ·
[Session contract and routes](docs/SESSION_LEASES.md).
Runner processes, research programs, storage parity and real shared-provider
browser/deployment verification remain open.

## Fixed workflow policy foundation — 14 September 2026

**386 tests pass**, with no failures, cancellations or skips, including the
prepared Nisa fixture. Backend/UI typechecks and builds pass. Workflows pins
fixed declarations and checks tool arguments against current assignment metadata;
Tasks supplies producer/reviewer policies. HTTP and MCP use canonical registry
descriptions. No plugin, dependency or public tool was added.

New coverage checks strict JSON and alternative bindings, immutable absence,
policy versioning, locale-independent hashes, native schema capture, metadata
admission during document failure, actual Cordis reload and application restart,
claim recovery and checkpoint leakage. Legacy fixture registrations preserve
the already-pinned policy rather than silently removing it.

Three fresh agents completed **40 calls: 37 successes, three expected permission
refusals and zero transport errors**, across two restarts. Three observed
assignment packets carried fixed policies; claiming a review preserved its
manifest. Four begin calls retained exactly two start events. The live run
preceded the final exclusion of interactive `workflow.begin` from fixed node
grants; ordinary begin is unchanged and the final suite covers that exclusion.

[Verification record](verification/workflow-execution.json) ·
[Sanitized live evidence](verification/workflow-execution-live.json) ·
[Contract](docs/WORKFLOW_EXECUTION.md) ·
[Fable dispositions](docs/reviews/workflow-execution-fable-design.md).

This is a policy foundation and trusted admission API. Ordinary keys retain
their existing authority. Real session credentials, policy-filtered discovery,
mandatory transaction guards, lease ownership and runner execution remain open.

## User-owned machine key checkpoint — 14 September 2026

**369 tests pass**, with no failures, cancellations or skips, including the
prepared Nisa fixture. Backend/UI builds and typechecks pass. Scope owns project
and account keys with immutable owner/grant/lineage; machine callers retain
current membership authority and cannot use human administration or mint
independent credentials. No new plugin or agent tools were added.

Coverage includes twelve core lifecycle tests, seven HTTP/MCP groups, two domain
provenance/credential-isolation tests, two mounted-dispatch race tests, and fourteen
browser-client tests in total. Three actual overlapping-worker races validate
rotate/rotate and both rotate/revoke orders. A separate 38-test Python reference
audit identified the public revoked-parent mint defect that this implementation
avoids through explicit atomic rotation.

Three fresh agents completed the task/review loop across two restarts:
**40 calls, 37 successes, three expected role refusals and zero transport errors**.
Both worker keys rotated while preserving attribution/grant/expiry. Additional
HTTP checks verified fixed-project confinement, account access to a later
membership, owner management after departure, account rotation using another
membership and revocation of a later successor through its retired ancestor.
Domain events retain the actual key and membership epoch.

[Verification record](verification/user-keys.json) ·
[Sanitized live evidence](verification/user-keys-live.json) ·
[Behavior and HTTP/UI contract](docs/USER_KEYS.md).
Fable's generic consultation led to account rotation after departure and explicit
write provenance; independent local review found no actionable authorization
bugs. Real shared-provider browser login remains unverified. Fixed node authority,
sessions, runner, research programs and storage-provider parity remain open.

## Shared identity and membership checkpoint — 14 September 2026

**343 tests pass**, with zero failures, cancellations or skips, including the
prepared Nisa integration. Backend/UI typechecks and production builds pass.
The independent Identity provider verifies signed user identities; Scope owns
project membership, roles and immutable grant epochs. Tests cover actual signing
algorithms, bounded JWKS retrieval, invitations, concurrent last-operator changes,
HTTP/MCP project isolation, local ownership repair and eleven browser-client cases.

Removing or downgrading a reviewer invalidates old claims immediately. Restoring
access before delayed recovery cannot revive them; context, checkpoints, workflow
admission and verdicts share the same guard. Fresh claims survive historical
recovery events. Rejected operations leave no new receipts, events or revisions.

Three fresh agents used synthetic signed human identities across two server
restarts: **42 calls, 39 successes, three expected role refusals and zero transport
errors**. The same user had a different role in a second project; cross-project
evidence was refused. Four begin calls retained exactly two start events.

[Verification record](verification/shared-identity.json) ·
[Sanitized live evidence](verification/shared-identity-live.json) ·
[Configuration and behavior](docs/SHARED_IDENTITY.md).
Fable completed a generic design consultation without source data, and final
independent local review found no actionable findings. This proves the local
shared-identity boundary, not deployed Supabase/Nisa login. User-owned machine
keys, sessions, runner, research programs and storage-provider parity remain open.

## Actor credential checkpoint — 14 September 2026

**293 tests pass**, with zero failures, cancellations or skips, including the
prepared Nisa fixture. The new tests cover migration, expiry, staged self-rotation,
lost-response recovery, secret retention, transactional rollback, actual competing
SQLite workers and credential checks across HTTP/MCP and delayed dispatch.
An additional 137 Python tests anchor the identity/session parity plan.
Backend/UI typechecks and builds pass.

Three fresh agents completed the task/review loop across two server restarts:
**42 calls, 39 successes, three expected role refusals and zero transport errors**.
Both worker credentials were rotated; old bearers were refused, actor attribution
and expiry were preserved, and the reviewer used its replacement after restart.
Repeated begin retained exactly two first-start events.

[Verification record](verification/actor-credentials.json) ·
[Sanitized live evidence](verification/actor-credentials-live.json) ·
[Credential contract](docs/ACTOR_CREDENTIALS.md).
Independent local review found no actionable bugs. Fable's generic design review
led to staged self-rotation and explicit self-expiry limits. Shared human accounts,
memberships and session leases remain open; no private-source audit or browser
sign-in is claimed.

## Workflow assignment checkpoint — 14 September 2026

**274 tests pass**, with no failures, cancellations or skips. The new coverage
includes full context preview, read-only lookup, admission and claim fences,
recipe withdrawal, atomic rollback, actual competing SQLite workers, version
upgrades, strict HTTP/MCP tools and durable history.

Three fresh agents completed the updated loop across two restarts: **42 calls,
39 successes, three expected role refusals and zero transport errors**. Producer
and reviewer each repeated begin; exactly two first-start events persisted, one
per revision. Backend/UI typechecks and builds pass.

[Verification record](verification/workflow-assignment.json) ·
[Sanitized live evidence](verification/workflow-assignment-live.json) ·
[Contract and remaining parity gaps](docs/WORKFLOW_ASSIGNMENT_PLAN.md).
Fable completed a generic design consultation without source files; this does
not claim the separately blocked private-source audit or browser sign-in.

## Review assessment checkpoint — 14 September 2026

**251 tests pass**, with no failures/cancellations/skips, including real local
HTTP/MCP and the prepared Nisa fixture. Backend/UI builds and typechecks pass.
Coverage includes versioned verdict formats, numbered findings, explicit waivers,
plain synopsis, structured observations, all verdict routes, transactional
rollback, old snapshots/receipts, recovery, scoping and stale-revision refusal.

The fresh three-agent run passed through two restarts: **34 calls, 31 successes
and three expected role denials**. It verified the persisted assessment against
the actual reviewer submission and recorded no transport errors.
[Checkpoint](verification/review-assessments.json),
[live run](verification/review-assessments-live.json),
[implementation](docs/REVIEW_ASSESSMENTS.md).

Fable completed a generic protocol-design consultation with no repository files;
[feedback and dispositions](docs/reviews/review-assessments-fable-design.md) are
recorded. The earlier private-source audit and browser sign-in remain pending
specific approval and are not claimed as completed.

## Structured task evidence checkpoint — 14 September 2026

**236 tests passed**, zero failures/cancellations/skips, including real local
HTTP/MCP and the prepared Nisa fixture. Backend/UI builds, typechecks, formatting
and whitespace checks pass. New tests cover numbered evidence confirmations,
canonical brief/assessment creation, atomic rollback, legacy contracts, unchanged
context replay across deployment/restart, binary evidence references, stale claims
and dynamic required input fields. Local review found two context regressions;
both have dedicated passing tests and no further material findings remained.

Three fresh live agents passed through two server restarts: **35 calls, 32
successes and three expected role denials**, with two context builds and no
transport errors. The reviewer read all pinned evidence before the verdict.
[Checkpoint](verification/structured-task-evidence.json),
[live evidence](verification/structured-task-evidence-live.json),
[implementation](docs/STRUCTURED_TASK_EVIDENCE.md).

Earlier Fable export and browser sign-in approval requests remain pending.

## Work-item dependency checkpoint — 14 September 2026

Workflows owns the persistent work DAG and shared prerequisite checks; Tasks,
context and UI consume it. **221 tests passed**, with zero failures/skips, including
actual HTTP/MCP dependency calls and the prepared Nisa fixture. Build/typecheck and
UI build/typecheck pass. Tests verify task chains, independent outcomes, scope,
cycles, missing targets, rollback, replay, frozen success criteria, provider
lifecycle, and stable assignment context when new downstream work is created.
Python comparison ran 29 passing tests. Local independent review found no further
material findings. [Report](verification/work-item-dependencies.json) and
[implementation](docs/WORK_ITEM_DEPENDENCIES.md).

No new live-model or visual check is claimed for this slice; earlier Fable and
browser approval requests remain pending.

## Task closure checkpoint — 14 September 2026

Producer/operator task closure is integrated through guidance, commands, context
payloads and the task UI. Legacy task definitions remain unchanged; only an
explicit legacy closure upgrades the instance, atomically with review closure and
failure recording. **208 tests passed with zero failures, cancellations or skips**,
including the Nisa MCP fixture and new HTTP/MCP, restart, rollback and version
compatibility coverage. Backend/UI builds, typechecks, formatting and whitespace
checks passed. Mounted tool names such as `_nisa.ask` are also accepted in guidance.

The Fable packet and disposable browser sign-in are pending specific approval;
neither is recorded as completed verification. Live agent acceptance passed across three fresh sessions and two restarts,
with nine successful guidance calls and all three expected role refusals.
[The checkpoint](verification/task-closure.json) retains the initial harness
prompt/assertion mismatch as well as the successful fresh run. [Implementation](docs/TASK_CLOSURE.md).

## Workflow guidance checkpoint — 14 September 2026

The existing Workflows service now evaluates registered domain checks and exposes
`workflow.status_and_next`. Tasks, saved context packages and the task UI use the
same decision; actual transitions recheck the rules transactionally. **187 tests
passed, zero failures/skips**, with the Nisa fixture enabled. Backend build and UI
build/typecheck passed. Browser verification covered producer work and waiting
for independent review. [Report](verification/workflow-guidance.json) and
[implementation](docs/WORKFLOW_GUIDANCE.md).

## Recovery and context checkpoint — 14 September 2026

All 185 checks pass, including atomic delivery/retry, unloaded-consumer recovery, claim migration/fencing, recipe registration/versioning, saved checkpoints and real HTTP/MCP context builds across restarts. Typecheck, build, formatting and whitespace checks pass. See [the current record](verification/recovery-context.json). No live model agent or production upstream service was invoked for this wave.

## Historical verification — 13 September 2026

The TypeScript build passes. After lifecycle, loader, remote transport, and credential/grant integration, the automated suite passes **165 checks** (155 top-level tests and ten component-boot subtests), with zero failures or skips. It uses upstream `cordis@4.0.0-rc.10`, native SQLite, real loopback HTTP, and the official MCP SDK client. [Execution evidence](EXECUTION_LOG.md) records clean-checkout verification and the added regressions; historical runs below retain their original results.

```sh
npm run build
npm test
```

## Mounts controlled integration and live sandbox verification

`npm run test:mounts` passes the mounts runtime regressions and the complete configured removal scenario. The application exposes 27 → 26 → 27 tools. An admitted authenticated upstream call drains while new mounted calls are refused; a native task, independent review, and feed posts complete with the mount absent. Restoration uses a new upstream connection and retains the same native providers and durable work. [Controlled mount report](verification/step-06-controlled-mount-unload.json).

Additional fixtures verify unavailable optional mounts, selected schemas, notifications, bounded discovery timeout, physical TCP loss, automatic recovery, explicit reconnection, separate discovery/caller authority, revocation, dependent-consumer draining, and cleanup failure reporting. The [feed removal regression](verification/step-06-feed-unload.json) also passes. All fixture credentials are synthetic.

After explicit user authorization, the prepared harness verified a consumer identity and one real `usage_report` call at the sandbox origin through Merv. A fresh ephemeral Codex session received the result with matching account, namespace, and member fields. There was exactly one upstream tool dispatch, no blocked request, and successful child/application shutdown, environment restoration, and temporary-state removal. [Sanitized live report](verification/step-06-live-sandbox.json). This proof covers a real permitted read; the separately retained fixture proof controls call overlap during removal and connection faults. The [Fable milestone consultation](docs/reviews/step-06-fable.md) is complete. Both behavior findings were independently reproduced and fixed: established notification streams survive the ordinary request deadline, and explicit reconnect waits for its own attempt. The final 165-check suite also verifies partial-constructor cleanup and queued reconnect failure/stop behavior.

## Credential and permission integration

The credential suite includes two-project authenticated HTTP/MCP scenarios with separate upstream identities and connections. Hidden tool names remain denied on direct invocation, and actor/grant/binding revocation and credential rotation take effect without restarting Merv. Focused tests cover changes during connection setup, admitted-call draining, timeout/failure cleanup, secret exclusion, and unchanged native role checks. Run `npm run test:credentials`. The default composition grants no remote access and mounts no live service yet.

At the step-5 gate, the full 141-check suite, typecheck, build, formatting, and independent reviews passed. The [step-5 feed-removal report](verification/step-05-feed-unload.json) also passed against the new dependency graph. The earlier live-agent run below remains the last model-driven acceptance; this credential gate uses controlled authenticated MCP fixtures.

## Remote transport and fresh-agent acceptance

Step 4 preserves native tools and adds validated remote catalogs, complete MCP result forwarding, independent project selection, pagination, refresh notifications, and generation draining. The full suite and independent reviews pass. [Compatibility matrix](docs/TRANSPORT_COMPATIBILITY.md) records the actual sandbox endpoint and installed agent versions, including the deliberately unsupported schema/protocol cases.

Three fresh Codex instances completed the native producer/reviewer/reader scenario across two restarts: **28 calls, 25 successes and three expected permission denials**. Each negotiated `2025-06-18`; the reviewer read the pinned evidence before submitting pass, and the final task reached `done` at revision 2. [Sanitized current report](verification/step-04-live-agents.json). This new run is separate from the historical agent acceptance below.

The final feed-removal repeat also passed after the transport changes. [Current feed report](verification/step-04-feed-unload.json).

## Feed removal through the loader

At this checkpoint, `npm run test:feed-unload` used `app.setEnabled('feed', false/true)` and the pinned upstream loader. It verified 26 → 22 → 26 tools, draining of an admitted post, a completed task/review while feed is absent, retained posts/activity, and a refreshed provider handle. [Committed report](verification/step-03-feed-unload.json).

## Earlier feed removal during an active run

The original `npm run test:feed-unload` passed using the official MCP SDK client against the running application. The only removal action was the feed provider's Cordis `Fiber.dispose()`. No tools or dependent plugins were manually removed.

| Phase         | Observed result                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feed active   | 26 tools; initial post and task created through MCP                                                                                                                  |
| Feed draining | Four feed tools disappeared; new feed calls returned `unknown_tool`; disposal waited for an admitted `feed.post`                                                     |
| Feed absent   | The admitted post committed; the original feed adapter became `PENDING`; task delivery and independent reviewer routing reached `done` at revision 2                 |
| Feed restored | Installing only the provider reactivated the original adapter; 26 unique tools returned; all three posts were readable; activity recorded during absence was visible |

The process stayed at PID `64235` and used the same loopback listener and MCP clients throughout. Assertions verify unchanged state, scope, artifact, workflow, review, task, registry, and API service instances. A test barrier makes the normally synchronous feed post overlap removal; real Cordis disposal, SQLite writes, and HTTP/MCP calls perform the actual work. This scenario is an MCP integration test; the separate Codex acceptance below records the earlier agent run.

[Structured removal report](live-runs/feed-unload-2026-09-13T12-55-42.878Z/report.json). The associated synthetic database is retained in that directory. The report is written only after clean shutdown.

## Earlier Codex task-loop acceptance

Three fresh, authenticated Codex CLI instances completed the synthetic task through MCP. Each had a separate Merv actor and an empty agent workspace. The application restarted between phases.

| Instance | MCP calls | Observed result                                                                                                                                                          |
| -------- | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Producer |        10 | Created immutable brief and delivery; task entered `in_review` at revision 1; `review.start` was refused by Merv                                                         |
| Reviewer |        10 | Read both pinned artifacts after restart; independently recomputed sum 20 and mean 5; submitted `pass`; task reached `done` at revision 2; artifact creation was refused |
| Reader   |         6 | Read the retained verdict, delivery, and workflow history after a second restart; creating an operator was refused                                                       |

The **26 calls comprise 23 successes and three expected permission denials**. All three CLI processes exited successfully. Saved transcripts prove the reviewer read the exact pinned brief and delivery before submitting its verdict. An additional database reopen verified the task, review, history, artifact hashes, and clean shutdown against the report.

The live result covers one small arithmetic task. More complex research quality, distributed execution, and production deployment are outside this acceptance test.

## Retained evidence

Run directory: `live-runs/2026-09-13T09-17-06.969Z/`.

- [Structured run report](live-runs/2026-09-13T09-17-06.969Z/report.json)
- [Exact-evidence and persistence audit](live-runs/2026-09-13T09-17-06.969Z/evidence-audit.json)
- [Producer transcript](live-runs/2026-09-13T09-17-06.969Z/producer.jsonl)
- [Reviewer transcript](live-runs/2026-09-13T09-17-06.969Z/reviewer.jsonl)
- [Reader transcript](live-runs/2026-09-13T09-17-06.969Z/observer.jsonl)

The saved run was rechecked with the final, stricter evidence verifier. Final shutdown-failure handling and rejection of incomplete transcript evidence also have automated regression tests. Live data and synthetic credentials remain local and are excluded from Git; this document does not contain bearer tokens.

Task: `wf_d30bd4b958e64b8e9e26bb9da37fc697`  
Review: `review_541fa6ce089e43639e4d9bbf3e6d0afd`

## Access consolidated into Scope — 2026-09-15

Scope now owns the internal `toolPolicy` module. The Access package, standalone provider and configuration entry are removed. Tools, Mounts and Sessions consume Scope; Sessions still registers a disposable policy without creating a Scope-to-Sessions dependency. Grants move to the Scope entry's `config.grants`. Identity and Credentials remain independent.

Validation: `npm run typecheck` and `npm run build` passed. `npm test` passed 641 tests with no failures; one optional cross-repository Nisa integration test was skipped because `MERV_NISA_CHECKOUT` was unset. Coverage includes exact grants, invalid replacements, revocation, Scope publication/reinstallation, session admission/fencing, API draining and independent mount unload. Logs: `/private/tmp/merv-scope-full.log`, `/private/tmp/merv-scope-typecheck.log`, `/private/tmp/merv-scope-build.log`.

The source-generated dependency inventory and deterministic SVG/PNG agree on 45 plugins and 105 dependencies. Browser verification confirmed the interactive DAG has no Access node and that hiding adapters yields 22 providers and 59 dependencies, with no browser errors.

## 2026-09-15 — Upstream credentials merged into External Mounts

- Removed the `@merv/credentials` package and Cordis service. Its resolver and public types now belong to Mounts; exact project/actor/mount selection, session authority, local-token rejection, private snapshots and connection identity behavior are preserved.
- Mounts takes `config.bindings` alongside `config.mounts` and injects only Tools and Scope. Default composition no longer installs Credentials. Scenario configurations and consumers were migrated; the Mounts README documents migration of existing configurations.
- The full test run passed: 641 tests, 640 passed, zero failed, one optional Nisa integration skipped because `MERV_NISA_CHECKOUT` was not set. Coverage includes isolation, rotation, revocation, malformed-binding rejection before namespace allocation, scoped HTTP/MCP calls, and removal/restoration while admitted calls drain. Build and typechecking passed.
- Regenerated dependency inventory, static diagrams and interactive explorer: 44 plugins, 21 providers and 103 declared dependencies. Browser verification confirmed the removed Credentials node and External Mounts' two dependencies (Tools and Scope).

## 2026-09-15 — Continuing agent identity and assignment execution separation

- Agent Sessions now owns persistent agent records, stable authenticated agent sessions, context-reset epochs and explicit assignment attachment. Scope retains each agent's security actor; Workflows owns individual execution leases. New source-controlled registration/retirement and credential-bound self-control routes allow external agents to retain one identity and credential across assignments.
- Existing execution IDs remain the keys for calls, domain reservations, Code captures and Runner recovery. Historical clients remain compatible. Automatic Runner dispatch creates fresh, nonpersistent agents; no automatic process reuse or handoff was added.
- Additive migrations remove one-actor-ever lease constraints while retaining live uniqueness, immutable snapshots, history and foreign-key integrity. Migration tests preserve an active execution and its dispatch receipt; failed rebuilds roll back and restore foreign-key enforcement.
- Task and experiment regressions exercise stable identity across assignments, current-execution artifact boundaries, and review independence. Other new checks cover HTTP/MCP continuity on the same connection, restart, idle state, resets, source revocation, retirement, ownership isolation, replay and stale-call/release fencing.
- Final full suite: 648 tests, 647 passed, zero failed, one optional Nisa integration skipped (`MERV_NISA_CHECKOUT` unset). Backend and UI typechecking/builds passed. No external model or production upstream was invoked.
- The UI separates agents from assignment executions. Architecture descriptions and diagrams were regenerated and checked in the browser; the graph remains 44 plugins / 103 declared dependencies.
- Usage, compatibility and migration details: `docs/AGENT_CONTINUITY.md`.

## 2026-09-15 — Agent sessions activity UI

- Delegated the UI implementation to the `agent_sessions_ui` sub-agent; integrated the Sessions-owned observation store and existing HTTP/UI adapters locally. No new plugin dependencies.
- Agent table contains all registered project agents in descending join order, including retired agents, and carries current work labels independently of the bounded execution table. Live-assignment switch, keyboard selection/escape, desktop right inspector and narrow-screen drawer were verified in the browser.
- Durable observations retain execution attribution across assignment changes and restart, distinguish running/succeeded/failed/interrupted calls, and never retain payloads, credentials or error messages. Permission probes and rejected input do not create execution records. The full suite caught the initial attempt to instrument permission preparation inside borrowed transactions; logging now starts at actual execution and the Code transaction regressions pass.
- HTTP/MCP tests cover same-project reader visibility, cross-project denial, worker denial, revoked readers, native failures, MCP `isError`, invalid remote envelopes, latest-100 bounds, aggregate totals and immutable finished observations. A 202-agent fixture verifies no silent directory truncation.
- Token figures are explicitly UTF-8 JSON payload-size estimates, not provider/model usage or billing; unknown outputs stay unknown. History starts at feature installation and covers only Merv calls.
- Final verification: **653 tests: 652 passed, 0 failed, 1 optional Nisa checkout skip**. Backend/UI typechecks and builds passed. `git diff --check` passed. Full regression log: `/tmp/merv-agent-ui-full-tests-final.log`.
- Refreshed disposable demo: `http://127.0.0.1:3081/ui/sessions`, using the final build and demonstration agents. Browser verified desktop layout, live filter, current and prior assignment details, token estimates, Enter/Escape navigation, and a 420×860 drawer without horizontal overflow. No model agents are launched by this demo.

## 2026-09-15 — Living research programs

- Integrated Paper, Reflections, Consolidation and Research, including domain tools and UI pages. Every child stage uses existing Workflows, Context Builder, Reviews and Agent Sessions; no second scheduler or remote compute/storage provider was introduced. Added the bounded local-file artifact-upload CLI through normal MCP authorization.
- Frozen paper/research sources feed five independent reflection lenses, immutable synthesis approval, separate consolidation and both exact Methods/Results publications. Additional prerequisites, per-experiment dispositions, Code proposal/reviewer-head binding, source fencing, recovery, restart, replay and rollback are exercised by real service tests.
- Independent review found synthesis could be assigned to a source unable to administer its review. The shared admission guard now enforces the verified wave owner or operator consistently, including delegated agents; its regression passes. Contributor exclusions are immutable review provenance and enforced before claiming or submitting.
- Final full regression: **682 tests: 681 passed, zero failed, one optional Nisa checkout skip**. Backend build, browser typecheck and production UI build pass; complete log `/private/tmp/merv-living-acceptance-suite.log`.
- A synthetic acceptance fixture completed the full new path through **39 successful HTTP tool calls**. The production browser bundle was checked for edits, citations/links, captured inputs, independent review links, consolidation state, both publications and read-only access. A lost-response proxy proved identical retry across tab changes/refresh recovers the original paper revision without duplicating it; the original result remained locked until confirmed. Older publications visibly became stale after a problem-definition change.
- All disposable local processes and acceptance tabs were closed. No production data, external model agents or upstream cloud resources were changed. This does not claim scientific validity, shared central Git publication or full Python parity.
- Full scope and evidence: `docs/LIVING_RESEARCH_VERIFICATION.md`, `verification/living-research.json`. Next gaps: `docs/REMAINING_PARITY.md`.

## 2026-09-15 — Paper changes inside scientific workflows

See [Paper/workflow responsibility verification](docs/PAPER_WORKFLOW_REFACTOR.md). Backend and UI builds passed; regression: 683 total, 682 pass, zero fail, one optional skip. Experiment/reflection verdict transactions include exact paper edits. Consolidation continues after Reflections and Knowledge unload. Browser verification includes approved paper edits and artifact-based consolidation creation. Native tool catalog: 64 (66 with UI). Dependency graph: 144 edges.

## Live reflections — 15 September 2026

New reflection waves read live research through existing tools. They create no corpus snapshot or input artifact. Initial contexts stay compact; independent lens and project boundaries remain enforced. Workflows blocks new tasks/experiments during an active wave while allowing existing work to continue; approval releases the pause.

- Full regression: **684 passed, zero failed, one optional skip** (685 tests).
- Focused reflection/research/consolidation/boundary verification: **39 passed**.
- Final live-read checks, including newly available reviews and evidence: **8 passed**.
- Backend build, UI typecheck/build, architecture generation and whitespace checks passed.
- Verified evidence attached after an agent's assignment becomes readable; unattached files, peer lens reports, foreign project data and unauthorized writes remain refused.
- Verified existing work can submit for review and close; new work is paused, create replay works, another project is unaffected, and unloading the reflection plugin cannot bypass the pause.
- Verified research metadata above 100 KB stays outside an assignment smaller than 16 KB. Source reads remain on demand using the existing tool response shapes.
- No changes to the 64-tool native catalog or the 144-edge dependency network. Version-1 waves and their stored receipts remain supported; new waves use version 2 and recipe version 3.

See [implementation contract](docs/REFLECTIONS.md) and [machine-readable verification](verification/live-reflections.json).
# 2026-09-16 — Production storage and isolated Azure staging

- Native PostgreSQL State and S3/R2 Blobs are implemented behind the existing contracts. Domain storage calls, explicit transactions, plugin activation and unload/drain now await asynchronous work. All 49 domain migrations have native PostgreSQL SQL.
- Final frozen-source regression: **781 tests; 780 passed, zero failed or cancelled, one optional external Nisa checkout skip**. Both PostgreSQL test environment variables were enabled. Backend/UI typechecks and production builds passed; deployment tests passed **9/9**. Log: `/private/tmp/merv-production-retention-final.log`. The refreshed production dependency audit reports zero advisories (`npm audit --omit=dev`); this does not cover development-only dependencies.
- Tests include atomic workflow/review/replay rollback, revocation during asynchronous operations, clean plugin unload, immutable large-object copy/download, deterministic legacy foundation/history import, human-only history pagination and project isolation.
- An immutable Linux candidate is running privately on the existing Azure VM. Its dedicated database role cannot read legacy tables. Real R2 put/get/conditional replay, PostgreSQL rollback, restart persistence, compiled UI/assets and origin checks passed. See [staging evidence](deploy/STAGING_2026-09-16.md).
- Supplemental figure/feed-media planning, legitimate empty-file preservation, projection-v2 credential exclusions and scientific-metric preservation, destination-bound transfer receipts and shared Sessions shutdown all pass. The history UI uses existing artifact access for attached files and enforces human membership/project isolation.
- Real source inspection found 1,551 preexisting metadata-only artifact rows referencing 1,228 absent object keys. Exact key and metadata tuples match the retained September 9 migration audit, with no newly missing objects. A checksum-bound exception list preserves all original archive data and explicitly labels availability; it does not excuse any other missing bytes. Native file records require verified copies. Original archive hashes and separate immutable retention receipts are both reconciled.
- The imported private Azure UI passed actual signed-in browser acceptance: 29 authorized projects out of 30 global projects, preserved memberships, historical experiment details, metadata-only notices without false downloads, and authenticated retained-file download preparation. No signed URL was logged. The largest historical detail is 710,212 bytes, below the viewer's 4 MiB limit.
- PostgreSQL token totals now normalize numeric aggregates to safe JavaScript numbers at the Sessions boundary. The exact Linux image also passed the real Azure PostgreSQL/R2 smoke: task/review/replay, one agent across two assignments and five observed calls, a five-lens reflection wave, signed file download, compiled UI and restart persistence.
- Isolated import and exact reconciliation passed: 30 projects, 43 memberships, 200 claims, 3,224 readable artifact records and all 54,314 archived history records. All 2,961 retained objects passed source/destination hash checks. Actual R2 ordinary/range downloads passed. See [accepted rehearsal evidence](deploy/REHEARSAL_2026-09-16.md).
- **No production cutover yet.** Legacy routes/services/data remain unchanged. At the end of this rehearsal the active-work decision and Fable review were pending; the subsequent review and private refresh are recorded below. Cutover still requires resolving old-work continuity, pausing the legacy writer, importing a fresh final snapshot into a new schema/prefix, reconciling again and verifying public HTTPS.

## 2026-09-16 — Optional Research providers, Fable reviews and UI refinement

- Research now requires only State, Scope and Workflows. Paper, Reflections, Knowledge and Consolidation bind through disposable Cordis injections. Missing providers block only stages that use them; reads, creation and committed request replay remain available. Reflections can start without Knowledge, and no-code research completes without Consolidation. Existing workflow versions and promised review/consolidation stages are preserved.
- Every used provider is checked before acquiring another provider, after asynchronous calls and before committing. Independent source review caught one replacement-between-calls race; the corrected implementation and regression prove no mixed-provider calls, partial child records or poisoned retries. Knowledge removal withdraws additional evidence grants while preserving the underlying research and reflection records.
- The final targeted selection covered **118 unique tests**. The initial run passed 115 and failed three because the disposable PostgreSQL instance used the wrong socket port. After correcting that test setup, all nine tests in the two affected suites passed. All 118 therefore have passing evidence on the unchanged final source. Logs: `/private/tmp/merv-optional-research-final-tests.log` and `/private/tmp/merv-optional-research-postgres-recheck.log`. This is targeted regression evidence, not a rerun of the earlier full suite.
- Backend/UI typechecks and production builds passed (`/private/tmp/merv-optional-research-final-build.log`). Strict dependency rendering and all 20 boundary tests passed. The regenerated DAG has **56 plugins, 138 required edges and six optional edges**; the browser shows Research's three required/four optional relationships, and Hide adapters leaves 25 providers and 82 edges.
- The project chooser now searches names and IDs, shows full IDs and sorts consistently. Previous research preserves the exact page/type/selection across artifact navigation and restores keyboard focus. Browser checks covered duplicate names, ID search, no-match state, page-two Back navigation, Escape and project isolation. Narrow-screen detail was checked with the existing sidebar collapsed; this does not claim a general mobile layout overhaul.
- The approved exact source packet received a completed `claude-fable-5` readiness review: no blocking defect in the reviewed excerpts, with operational conditions. Separate completed dependency/UI and optional-Research design consultations informed this wave. The later Research/UI implementation was locally source-reviewed and tested; it was not inside the earlier frozen source packet. See [readiness review](docs/reviews/production-readiness-fable-final-v2-20260916.md), [dependency/UI discussion](docs/reviews/dependency-ui-fable-20260916.md) and [optional Research design](docs/reviews/research-optional-design-fable-20260916.md).
- The private Azure image was refreshed with all **54 configured plugins active**, unchanged private configuration and matching before/after imported metadata checksums. Health/assets/authentication/origin checks passed. Image and rollback evidence: [staging refresh](deploy/STAGING_REFRESH_2026-09-16.md). Public routes and the legacy writer remain unchanged; the old unfinished-work decision and fresh final import/public HTTPS acceptance still precede cutover.
