# Terminal-agent launch acceptance

This harness runs **real fresh Codex and Claude Code model sessions** through the installed native plugin/MCP connection. It makes no Merv HTTP calls. Production runs belong to the release operator after deployment; preparation and self-tests neither deploy nor provision anything.

`coverage.json` is a static candidate inventory, with source locations and scenario area mappings. Its legacy worker snapshot includes aliases and may include retired tools. **Area mapping is not action coverage or a pass.** Regenerate after integration, retain actual client tool discovery/schema evidence, and reconcile every exposed noun action and worker-only tool against the inventory. An enabled capability without executed evidence remains a launch gap. Disabled/retired surfaces need explicit evidence and a release-owner scope decision; they do not turn into passes.

## Reuse and boundaries

The October audit's `dev_docs/mcp-audit-2026-10-19/e2e/run-agents.sh` and `summarize.py` (present in the working checkout but absent from this branch's base) informed the real-process approach and both JSON event parsers. This harness supersedes their silent `|| true` failures and global tool preapproval for launch validation. Existing test paths remain authoritative:

- `deploy/runtime-acceptance.mjs`: PG/S3 persistence, compiled UI, managed code, signed download, restart. It uses direct SDK/HTTP and synthetic review; it is **runtime evidence**, not agent UX acceptance.
- `scripts/live-sessions.ts`, `live-codex.ts`, `live-scenario.ts`: real-model internal/local workflow regressions; inspect their environment requirements and costs before running. They are not public OAuth onboarding.
- `tests/pi*.test.ts`, `tests/session*.test.ts`, `tests/workflow*.test.ts`: deterministic Pi, session, and workflow boundaries.
- OAuth branch `scripts/oauth-client-smoke.ts`: native-client protocol/config checks using synthetic consent. Does not prove real browser identity or a model's fresh-chat reuse.
- Standard Git branch tests: remote transport and assigned-branch fences. Scenario `git` adds actual owner/worker UX and receipt evidence.

No existing implementation files are modified. The new harness has no third-party dependencies (Python 3.9+ on POSIX). Local model auth remains in native stores; OAuth credentials remain in the isolated client's private config directory. Native CLI transcripts can contain sensitive data, so never publish the whole run/config tree. Only inspect/export redacted `proof/` files after human review. Redaction covers common tokens, Bearer values, URL userinfo and URL queries; it is defense in depth, not a guarantee for arbitrary secrets.

## Prepare after integration

Run from `merv-typescript/`:

```sh
python3 -m unittest discover -s acceptance -v
python3 acceptance/harness.py preflight /tmp/merv-client-preflight.json
python3 acceptance/harness.py inventory /tmp/merv-candidate-coverage.json
python3 acceptance/harness.py init /tmp/merv-launch-20261021 \
  --url https://experiments.rapidreview.io/connect/agent.md \
  --project-id SYNTHETIC_PROJECT_ID --deployed-revision EXACT_DEPLOYED_SHA \
  --codex-auth "$HOME/.codex/auth.json"
```

Use a new path. Candidate revision is recorded from Git; deployed revision must be independently verified against the release/deployment receipt. `--codex-auth` is optional and makes a symlink to existing model auth **without reading/copying it**; omit when model auth uses a native keychain or complete native sign-in in the isolated config. Never link the whole user config. Claude's isolated config may require native model login if its installed version cannot reuse keychain authentication; stop and use its normal sign-in, never export/copy tokens. Ambient API keys, if already configured, stay in the inherited environment and are never logged. Merv and client routing overrides are removed for captured runs.

`preflight` only checks installed flags/versions, not authentication. The observed preparation versions were Codex `0.155.0-alpha.2` and Claude Code `2.1.304`. Claude has a $2 API budget per captured turn; Codex exposes no corresponding budget flag, so its cap is wall time/output only. Default timeout is ten minutes, maximum thirty. Each attempt kills its process group on exit/timeout, but remote hosted work can outlive a client: inspect/cancel it through scenario `cleanup`.

## Genuine onboarding and approvals

Open a terminal and use the generated private launchers:

```sh
/tmp/merv-launch-20261021/codex/interactive.sh
/tmp/merv-launch-20261021/claude/interactive.sh
```

Start with **only the deployed `/connect/agent.md` URL**. Follow published plugin instructions. Use genuine browser account sign-in and project consent; account creation/invitation/project creation may require the website. Do not simulate consent or paste tokens into chat. Record browser evidence with account details redacted inside the respective `proof/` directory. Test the website path separately. Reload only when the client requires it. For fresh reuse, exit and start a new process with the same isolated config/workspace.

Captured headless runs preserve default approval boundaries: Codex on-request with workspace-write; Claude manual permissions and denial when there is no permission handler. They **do not blanket-approve Merv tools**. If a write or shell command needs approval, use the interactive launcher to resume that exact session, approve the specific intended operation, and then continue captured observation. An unavailable interactive approval channel is `blocked`, not a reason to add bypass flags. Interactive terminal sessions are not automatically bounded/captured by this harness: keep them supervised and retain sanitized evidence manually. URL-only installation itself often needs these interactive approvals.

```sh
python3 acceptance/harness.py run /tmp/merv-launch-20261021 --client codex --scenario fresh-chat --dry-run
python3 acceptance/harness.py run /tmp/merv-launch-20261021 --client codex --scenario fresh-chat
python3 acceptance/harness.py run /tmp/merv-launch-20261021 --client claude --scenario fresh-chat
```

Run each applicable scenario for both clients. Scenario prompts are in `scenarios.json`; dry-run prints the exact prompt/command without launching an agent or calling production. The `setup-url` and `website` captured runs create a ledger, but human consent/browser proof must be added to their attestation. No shell/API preconfiguration of Merv is performed by `init`, so setup is actually tested.

## Workflow and compute sequence

1. Setup URL and website; fresh-chat, permissions, auth lifecycle and migration using isolated test accounts/configs. Prepare a reader identity, inaccessible synthetic project and unrelated config sentinel separately; never mutate a real user's grants for a negative test.
2. `experiment`, `task`, `revision-resume`, `storage`, `knowledge`, `feed-board`, `operations`, `public-intake`. Use stable request IDs tied to run ID and recover existing records. The fixture takes milliseconds, uses only the standard library, retains seed/hash/exact arithmetic, and makes only an empirical algebraic claim.
3. Hosted worker and Pi scenarios require the release operator's separately allocated CPU capacity/dispatch configuration. Both owner-side request/status and hosted worker execution/session/review receipts must be retained. A terminal owner doing the work is not evidence that hosted execution works. No worker available means blocked. The harness never provisions, enables dispatch, or pays for compute.
4. Real independent design/result/task reviewers must inspect actual retained evidence under authorized identities/leases. Reflection requires all five lens contributions and independent reflection/consolidation gates. An owner's forced approval is not acceptance.
5. Git scenario separates owner standard clone/fetch/user-branch push from a leased worker’s assigned-branch push. Never put credentials in remote URLs or commands. Retain remote refs, commits, rejected unauthorized push and immutable submission/approval receipts.
6. Cleanup observes exact run-owned resources and closes only allocated disposable compute/jobs. Preserve artifacts, review decisions and Git receipts. Local process cleanup does not prove remote cleanup.

## Optional Git authentication after plugin OAuth

MCP OAuth acceptance does not establish Git access. The Git implementation currently documents Basic authentication with username `merv` and a Merv user key; the native MCP OAuth token is resource-bound and must never be repurposed. Validate this actual user path against the integrated/deployed instructions:

1. The signed-in person opens Settings → Keys, creates a dedicated **project-scoped** key for the synthetic project with a short expiry, and records only its label/ID/scope/expiry. Account-scoped grants are broader and must not be silently substituted.
2. Copy the exact credential-free project remote from Code. Run ordinary `git clone <remote-url>`, supplying `merv` and the key only through the native secure credential prompt/OS credential manager (for example the existing macOS Keychain helper). Never put the key in a URL, command argument, chat, captured terminal output, or repository configuration. No Merv-specific helper, watcher or daemon is required. Do not install a custom helper to rescue acceptance.
3. Fetch again in a fresh process to prove persistence. Confirm role semantics: reading follows current membership; pushing ordinary user branches currently requires project administration. User keys cannot push `merv-main` or `merv/*`. Hosted leased worker credentials have a separate assigned-branch fence and must be tested as that worker, not simulated with an administrator key.
4. Revoke only this test Git key through Settings → Keys, start a fresh Git request and verify denial. Verify the separate MCP OAuth connection still works. Remove the dedicated credential-manager entry using its normal UI after the test; preserve unrelated credentials.

The harness never supplies a privileged key. If the release's published onboarding omits these steps, mark `published_optional_setup` blocked even if a manually arranged transport test passes. Record role constraints and human steps as part of the user journey. This optional Git path must not block research-only plugin use.

## Resume and evidence

A launch writes an exclusive attempt marker before starting. It refuses to run the same scenario again without `--resume SESSION_ID`; the ID must occur in that scenario's saved events. After timeout or interruption, inspect the retained JSONL and remote workflow state before resuming. If the process died before any session ID was recorded, manually reconcile IDs/state before retiring that attempt and starting a new run directory; **never delete a marker simply to retry a creation**. Different scenarios may intentionally continue the same project, so give the agent the existing IDs in interactive context if discovery cannot resolve them.

```sh
python3 acceptance/harness.py run /tmp/merv-launch-20261021 --client codex --scenario experiment --resume EXACT_SESSION_ID
```

The ledger records run/candidate/deployed revision, client/version, scenario, timestamps, session IDs, tool observations, errors, exit status, proof paths/hash, workflow/receipt placeholders and cleanup. Exit zero is always `blocked: evidence_review_required` until adjudicated. A client error is `fail`; timeout/output limit is `blocked`. Agent prose never automatically passes a scenario.

Create a separate JSON evidence file using `evidence.example.json`. Include every check from that scenario, retained proof paths, concrete observations, actual workflow/receipt IDs (empty only when inapplicable), reviewer identity and cleanup. Place proof files under that client's `proof/` directory. The reviewer must compare server-visible records/receipts and transcript evidence; the harness validates completeness and hashes, **not truth or reviewer independence**. Review must not be delegated to the same actor whose workflow delivery is under review.

```sh
python3 acceptance/harness.py attest /tmp/merv-launch-20261021/codex/proof/fresh-chat-001.json /tmp/fresh-chat-evidence.json
python3 acceptance/harness.py summary /tmp/merv-launch-20261021
```

Attestations are separate from immutable-at-review raw ledgers and hash all proof files. Summary marks changed evidence blocked and lists every scenario for both clients, including not-run entries. This strict summary remains blocked for optional disabled capabilities until the release owner records a separate scope decision; it never silently drops them.

## Preparation evidence and remaining launch gates

Local tests cover split-token redaction, process/descendant timeout cleanup, output caps, event parsing, approval-safe command construction, deterministic fixture and evidence validation. They do not use model calls, accounts, production, OAuth consent, provisioning or mocked Merv success.

Production acceptance is not yet run. Required release gates include deployed OAuth browser sign-in, actual plugin skill discovery/fresh-chat reuse in both clients, independent workflow reviews, hosted worker/Pi behavior, standard Git lifecycle, expiration/revocation/permission negatives, and verified cleanup. Reconcile live discovery against static tool inventory after the two implementation branches are integrated. Existing runtime/deploy regressions should also run under release coordination; they are complementary evidence rather than substitutes for this matrix.
