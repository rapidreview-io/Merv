# Exact-action launch preparation

Pinned candidate: `4530bd6224b869ab8989814bf70d979f039d8428`.

This replaces area-level coverage with **211 exact action/tool rows in 38 stages**. All rows are **not_run**, not acceptance passes. There are **142 actions in the measured external operator listing** and **10 further conditional external actions** (Fleet and legacy history). Other rows deliberately cover website-only controls, genuine worker/Pi/intake-profile tools and hidden compatibility names. The two worker SSH actions are included even though external conversations cannot discover them.

- [ACTION_MATRIX.md](ACTION_MATRIX.md): reviewable operation/evidence table, one row per exact action.
- [action-matrix.json](action-matrix.json): exact argument style, required fields, field schemas, binding templates, source file, aliases, fixture identity, operation, evidence, lane and availability for every row.
- [operator-tools.json](operator-tools.json): actual local registry MCP listing, using the existing `tests/fixtures/tool-list-size.ts` measurement helper.
- [registered-tools.json](registered-tools.json): actual registration schemas for all application tool modules plus intake/worker definitions and vendored SSH schema. Services are inert during extraction; handlers are never called. This is metadata extraction, not mocked execution success.
- [preparation-evidence.json](preparation-evidence.json): provenance, hashes, validation and remaining blockers.

The measurement helper creates isolated schemas on loopback PostgreSQL, enables optional Feed/Nisa/Web/Sandboxes definitions for measurement, lists tools, then closes clients/services and drops its test schemas. It neither calls their action handlers nor allocates compute. Actual deployed enablement and native-client visibility remain to be verified. The registration extractor reports every unsupported registration as a gap and matrix generation refuses gaps or missing recipes.

Parent maintenance integration advanced to `a5fe8936ca60276d5dfeb4427f943715597b7136` during preparation. Registration extraction was rerun against this worktree pinned at `4530bd6`; all 82 registration definitions were byte-for-byte structurally equal to the later maintenance candidate's extraction. This does not assert unchanged runtime behavior or future revisions. Refresh discovery after final deployment.

## Execution setup and sequence

First perform the original URL-only plugin installation, real browser consent and fresh-chat scenarios in the parent runbook. Follow the published guide's one-time, Merv-only permission choice and verify it persists; do not add harness-only approval bypasses or alter unrelated permissions. Do not register direct bearer MCP configuration, inject Git credentials, synthesize OAuth consent, or call domain HTTP endpoints to claim native UX. Keep these journey checks separate from action coverage.

Prepare a run-owned synthetic project with normal website membership. Retain the exact deployed revision, candidate revision, account/project IDs and native CLI versions. Required identities are:

1. Owner/operator with ordinary native plugin OAuth; a separate reader and inaccessible synthetic project for denial checks.
2. Actual assigned producers and **independent** reviewers under legitimate leases/attribution. A second API key under the producer is not an independent reviewer. Task passes require the reviewed checkout.
3. Five independent reflection lens authors, synthesis and independent reflection/consolidation reviewers, using the actual workflow.
4. Bound intake Pi profile and leased customer worker only for the isolated public-intake request. No payment is authorized by this preparation.
5. Already approved run-owned compute for runtime checks; admin observer for exact sandbox/job/Fleet receipts. Missing capacity is blocked, not a reason to allocate it.

Create cheap local byte fixtures:

```sh
python3 acceptance/fixtures/make_files.py /tmp/merv-action-fixtures
```

This writes actual seeded JSON, a 16x16 red/blue PNG, README and measured byte/hash manifest. Total file size is tiny. Use these in files/board/report/Git checks; do not claim scientific generalization from the sample-mean algebraic fixture.

Execute stages sequentially with pauses at workflow gates. Stage numbers organize artifacts; **they are not a blind one-pass batch**. The normal route is:

1. `01-orientation`, `02-file-create`, `03-files`, `04-board-create`, `05-board-read`.
2. `25-literature` first when a citation is needed; then `06-paper-write`, `07-paper-read`. Missing optional literature service stays blocked; do not invent a citation.
3. `09-task-create`, `10-experiment` through the first review gate; inspect `08-workflow-orientation`. Run genuine assigned work (`11-assigned-work`) and reviewer stages `13-independent-review`/`14-review-observe` on their actual identities. Resume `10-experiment` for execution/result submission and its next independent review. Use `12-workflow-observe` to read retained final evidence. A blocked dependent task must not start early.
4. `15-session-controls` and `16-session-observe` on already running/retained fixture work. Resume the same work after interruptions. Owner session observations and hosted worker execution evidence are distinct requirements.
5. Optional ordinary Git authentication from the main runbook, then `18-git-observe`. `19-git-recovery` requires separately prepared, disposable failed/suspended/quarantined bases; do not damage production to create fixtures. Healthy-state rejection alone does not satisfy a positive repair/recovery row.
6. `20-research`, `21-reflection`, `22-research-observe`, returning to actual independent workers/reviewers as required. Finish the main wave before creating the separate abandonment fixture. Keep automatic cycles off and nextWave skipped.
7. Optional `24-optional-feed`, `26-optional-archive`, `27-script`. Read-only absence remains disabled/blocked; no silent pass.
8. Compute stages `30`–`36` use separately allocated capacity. Job runs take at most ten CPU seconds; cancellation uses a separate short bounded sleep. Creation, renewal, snapshots/restoration, pipelines, Fleet retry and Nisa agent runs remain separately metered release gates. Retain provider cleanup receipts; client shutdown is not remote cleanup.
9. `40-pi-ui`, `41-intake`, `41-intake-worker`, `42-ui-only`, `43-credential-boundary` require their genuine website/Pi/worker surfaces. The stage launcher rejects attempts to execute wholly non-external stages as an owner terminal.

Many controls intentionally require distinct disposable targets: failure task, abandoned research cycle/wave, cancellation job, quarantined/mismatched base, exhausted loop/dispatch hold. Prepare these through supported workflows under release coordination. Never reuse the successful evidence-producing unit for destructive checks. Each row states its own fixture and readback. Always read latest revisions and use a stable request ID tied to run/action; never guess IDs or retry creation after uncertain outcomes.

## Runnable stages through the existing native-client harness

From `merv-typescript/`, after `harness.py init` has created the isolated run:

```sh
# Default is dry-run: exact native command/prompt, no model or Merv call.
python3 acceptance/action_matrix.py stage /tmp/MERV_RUN \
  --client codex --stage 01-orientation > /tmp/orientation-plan.json

# After deployment and parent authorization, launch a real fresh native client.
python3 acceptance/action_matrix.py stage /tmp/MERV_RUN \
  --client codex --stage 01-orientation --execute
python3 acceptance/action_matrix.py stage /tmp/MERV_RUN \
  --client claude --stage 01-orientation --execute

# Continue an existing stage with the exact captured session ID.
python3 acceptance/action_matrix.py stage /tmp/MERV_RUN \
  --client codex --stage 10-experiment --resume SESSION_ID --execute
```

Each stage combines coherent reads/writes into one agent turn rather than starting a model for every action. `--bindings /tmp/fixture-bindings.json` may supply **non-secret** run fixture IDs/revisions/paths. Binding templates explicitly use `$bind` placeholders. They are not fabricated executable arguments: the agent must resolve them from real current records and inspect the live schema before calling. Sandbox actions have **flat arguments**, unlike Merv's nested noun actions; the matrix preserves this distinction, including union-conditioned required fields. No action receives invented IDs, revisions, claims, tokens or reviewer authority.

Captured execution retains the existing timeout/output cap/process cleanup, default approval policy, isolated client configuration and exact-session resume protections. Stages stop at genuine human approval or missing prerequisites. They never authorize allocation, paid research, credential creation, dispatch enablement or customer purchase; those rows require a separately authorized release interaction and retained proof. Dry runs do not produce acceptance results.

Stage ledgers are named `actions-STAGE-NNN.json`; all four check names for each action are recorded separately. Adjudicate them with the existing `harness.py attest` command, requiring actual native action evidence, domain outcome, independent readback and cleanup. An exit-zero stage remains blocked until reviewed. The original `harness.py summary` covers the original journey scenarios, **not these extra action rows**; use the action reconciliation report alongside stage attestations. Neither tool should be described as a comprehensive launch pass alone.

## Live discovery and action reconciliation

In each actual fresh native client, retain the exact tool/schema discovery through its supported discovery/search facilities; `script.tools` can supply native declarations for deferred Merv tools. Export a sanitized JSON object `{ "tools": [{"name": "...", "inputSchema": {...}}] }` into that client's proof directory, with the native transcript/screenshot proving where it came from. Record role, account, project and deployed revision. **Do not pass this preparation's operator-tools.json as live discovery.** If the client does not expose full schemas, retain partial discovery and mark its missing coverage explicitly.

```sh
python3 acceptance/action_matrix.py reconcile /tmp/action-observations.json \
  /tmp/MERV_RUN/codex/proof/actions-01-orientation-001.jsonl \
  /tmp/MERV_RUN/claude/proof/actions-01-orientation-001.jsonl \
  --discovery /tmp/MERV_RUN/codex/proof/live-tools.json
```

This compares exact tool **and action**, retains transcript path/line, reports new or absent live actions and unknown observed actions, and hashes the discovery input. Codex failed calls stay failed/unknown; Claude `tool_use` alone is only an attempted call, never a verified outcome. Script-mediated nested calls and old aliases require their actual server-side call evidence and manual reconciliation; a script invocation does not satisfy every tool it could have called. Observed rows remain `observed_not_verified`; matching an action name never earns a pass. Native discovery is client/role-specific—do not merge it into a fictitious universal permission set.

## Disabled, conditional and retired surfaces

- Feed is disabled in committed `config/default.json`; the candidate renderer does not turn it on. The measurement fixture deliberately enables its definitions. Four Feed action rows remain disabled/blocked unless actual release configuration proves otherwise.
- Nisa and Web require their renderer environment configuration. Nisa start/follow-up incur separate service spend; the Claude model budget does not bound it.
- Sandboxes requires its configured host/database. Fleet and Pi add explicit enable flags; public intake additionally requires Pi and workflow dispatch. Legacy history requires an imported source ID. Missing services do not justify provisioning in this task.
- `pi.*` controls are UI-tier. `screen.read` is internal conversation-only. Intake actions require a bound intake profile; delivery/report/SSH actions require actual assignment/worker authority. An external agent's inability to call these is an expected boundary, not evidence that the corresponding product journey works.
- `actor.*` credential administration is UI-tier and refused for key/OAuth/worker/Pi callers (`tests/credential-lock.test.ts`). Do not mint another credential to rescue coverage or reviewer independence.
- GitHub integrations and old `code.commit`, `code.merge`, `code.mirror.retry`, `code.publication.control`, `code.publication.merge`, `code.repository.import` are absent from candidate registrations and were removed by the Git cutover. Ordinary Git push/fetch and retained review/integration receipts are the replacement journey. Do not fabricate calls to removed tools.
- `code.local.bind` and `code.repository.rebind` are explicitly removed names redirecting guidance to `repository_prepare`; cached aliases listed per row are distinct from removed operations.
- `report.open` and legacy `nisa.research` are hidden cached compatibility entries, not current external discovery. Their rows are labelled compatibility-only. Existing old flat noun aliases are recorded on the canonical rows; they do not count as a fresh-plugin noun-action success.
- There is no standalone exposed `claim` noun in this candidate. Project knowledge is represented through paper, citations/references, actual artifacts and reflection/research records. Payments, membership administration and account creation are website journeys, not invented MCP actions.

## Reproduction and limits

Use a checkout pinned to the exact target revision with its actual dependencies/vendor checkout. The extractor reads registration declarations and fails on unhandled registration hooks. It does not call service handlers.

```sh
# On the pinned candidate, local test PostgreSQL ONLY:
MERV_TEST_POSTGRES_URL=postgres://127.0.0.1/postgres \
  node --import tsx tests/fixtures/tool-list-size.ts /tmp/operator-tools.json
node --import tsx acceptance/extract-definitions.mts "$PWD" /tmp/registered-tools.json
# Optional fourth argument points to an initialized, same-revision Sandboxes vendor checkout.

python3 acceptance/action_matrix.py build
python3 -m unittest discover -s acceptance -v
```

For a new candidate, put its snapshots in a new versioned directory and deliberately update `SNAP`, provenance and coverage tests rather than overwriting the pinned evidence. Production configuration, role visibility, scientific workflow execution, independent reviews, real browser sign-in and provider cleanup have **not** been tested here. Exact parameter-enum/error combinations beyond each recipe remain additional domain-test coverage, not implied by one action row.
