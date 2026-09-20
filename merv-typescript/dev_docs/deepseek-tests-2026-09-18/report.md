# DeepSeek agent acceptance tests for Merv

Tested 2026-09-18 UTC with DeepSeek V4.1 Flash (`deepseek-flash`, high reasoning), Codex CLI 0.155.0-alpha.2, Node 22.13.1, and Merv commit `b9290878995ab7343138ecab28f632a7a4fbc8bb`.

## Result

The bounded local tests support Merv's task/experiment transitions, independent actor attribution, immutable evidence, permission checks, credential rotation, and recovery. They do **not** establish clean unattended compatibility: **3 of 5 live acceptance runs passed their original assertions; 2 failed**. The failed runs remain failed in this report, even though their workflows reached terminal states and the substantive arithmetic checked out.

Across the five runs, **13 fresh DeepSeek agents made 115 MCP calls**: 109 succeeded, 3 were expected permission denials, and 3 were rejected input attempts that agents corrected. The ordinary automated suite had **852 passes, 0 failures, and 18 skips**. Seventeen skips require PostgreSQL; one requires the Nisa cross-repository fixture.

All live tests used fresh local TypeScript Merv instances and synthetic data. Production Ledgerline was not accessed. The earlier configured development endpoint exposes the older Python Merv interface and is not the current Ledgerline service.

## Runs

| Test | Fresh agents | MCP calls | Original acceptance result | Observed state |
| --- | ---: | ---: | --- | --- |
| User keys, task review, permissions and restarts | 3 | 43 | Pass | Task `done`, revision 2 |
| Automatic dispatch, first run | 2 | 18 | **Fail: required `review.get` omitted** | Task `done`, revision 2 |
| Automatic dispatch, unchanged replication | 2 | 19 | Pass | Task `done`, revision 2 |
| Git-backed experiment: plan, design review, execution, results review | 4 | 28 | **Fail: reviewer proof output did not match verifier contract** | Experiment `complete`, revision 4 |
| Negative review return routes | 2 | 7 | Pass | Invalid design → `planned`; repairable execution → `running` |

The dispatch replication used the same harness and prompt, with fresh fixture data. The result is one strict pass and one strict failure, not a statistical estimate of reliability. No reviewer was re-prompted to change a verdict.

## What was verified

- The task producer could not review its own delivery; the reviewer could not create evidence; the read-only observer could not create an operator. All three requests returned `forbidden`.
- Key rotations invalidated old bearers while preserving identity and attribution. Account/project grants, membership-dependent roles, cross-project artifact refusal, ancestor revocation and independent-key survival passed the existing assertions.
- Work-start retries retained a single activation per revision. Task evidence, reviews and attribution survived two server restarts. Dispatch leases survived pause/restart and retries did not create duplicate leases.
- Two independent reviewers distinguished an unmatched, training-set-only design from a usable plan with an incorrect denominator. Their actual verdicts and destinations were retained.
- The experiment ran real local Python. Its planner, executor and two reviewers had distinct identities. The runner captured modified tracked code and an untracked result file, and the attempt reviewer received that exact Git commit.
- A separate audit opened the databases read-only, recomputed **17 artifact hashes and byte counts**, checked **7 submitted reviews** for different producer/reviewer identities and valid pinned artifact references, and recalculated the experiment from its retained input arrays. Training-only OLS gives slope 2, intercept 1, candidate MAE 0, and baseline MAE 8 across the same five held-out examples.
- An additional Git audit confirmed the captured code and stdout equal the retained artifact bytes. The source and central branches retained their original commit. Worker cleanup completed, the ephemeral review checkout was removed, and no processes referring to this test-run directory remained.

## Findings

### 1. DeepSeek does not consistently perform every requested review read

In the first dispatch run, the reviewer read all three pinned artifacts and obtained review information through `review.start`, but omitted the separately required `review.get` call. The harness correctly failed its explicit procedure check. An unchanged replication performed that call and passed. This is an agent instruction-following failure; it is not evidence that the arithmetic was unreviewed or that Merv bypassed an authorization gate.

Evidence: `dispatch-v2/reviewer.jsonl` in the retained run directory; the independent database audit shows the actual passing verdict, distinct actors, expired leases, and two work-start records. Keep explicit required-call assertions for procedures that matter; do not infer them from the closing agent message.

### 2. The experiment verifier rejects formatted JSON and the emitted proof has shape differences

`scripts/live-experiments.ts:533` parses each stdout line as a standalone JSON value. The reviewer executed a successful Python verification program that printed one valid, indented JSON object with `checks: "all passed"`; line-by-line parsing could not recover it, causing the assertion at line 546.

The proof also omits `baseline.predictions` and `candidate.slope`/`candidate.intercept` from its nested summary, and adds a criterion field. The following exact-object assertions would reject those shapes even after fixing JSON parsing. The reviewer's executed program did check these values against the retained result; our independent audit corroborated them. The proof artifact preserves what the program actually printed.

The same run contains two recovered MCP input errors: a reused request ID and an overlong synopsis. The harness separately requires zero failed calls, so relaxing its parser alone would **not** make the original run pass. Report recovered failures separately from clean first-attempt acceptance. For proof interchange, either explicitly require compact JSON with an exact schema or parse a complete JSON object and validate the required fields without discarding unexpected differences.

### 3. The dispatch harness's `failed` field mislabels an actual failed tool call

`scripts/live-sessions.ts:106` sets `failed` using only `item.error` and `result.isError`. The first reviewer submission had `status: "failed"`, a returned `invalid_synopsis` error, and `failed: false` in the harness log. Merv's own `session_tool_calls` table correctly recorded the failure. The agent corrected the synopsis and resubmitted successfully.

The harness should include `item.status !== "completed"` in its failure classifier, as `live-experiments.ts` already does. Counts in this report come from the actual tool status and structured error, not that faulty boolean. No repository implementation or test source was edited during this assessment.

### 4. Local shell access can extend beyond the MCP evidence path

After reading the pinned artifacts through MCP, the experiment reviewer searched the local run directory and directly read server blob files to recompute hashes. It also listed a blob path from another synthetic fixture. It did not write to these stores. This test therefore demonstrates MCP project isolation, but not filesystem read isolation between a co-located controller and agents. Sensitive local deployments need an explicit read boundary or a separately hosted server if that confidentiality property is required.

### 5. Setup and execution friction was retained

The initial test launcher put provider overrides before the `exec` subcommand. The model option arrived but provider configuration did not, so OpenAI rejected `deepseek-flash` before any Merv tool call. Moving the overrides into the `exec` arguments fixed the launcher; the three initial failed attempts are retained separately and are excluded from the 13 DeepSeek agents above.

Codex warned that DeepSeek model metadata was unavailable and used fallback metadata. Native workers also encountered macOS heredoc/temp-directory restrictions and recovered with alternative local commands. Two shell commands had nonzero exits; another compound command masked a heredoc failure with a successful trailing `echo`. Successful final arithmetic was verified independently rather than inferred from process exit alone.

## Evidence and reproduction

- `run-results.json`: run outcomes, actual call/error counts, session IDs and transcript hashes.
- `independent-audit.json`: read-only database observations and artifact/hash/calculation verification.
- `evidence/`: key/permission checks, negative review verdicts, original reviewer proof, Git capture/cleanup audit, and deterministic test skips.
- `source-hashes.json`: hashes of the exact harness source files used.
- Raw transcripts, synthetic databases and retained workspaces: `/private/tmp/merv-deepseek-acceptance-20260918`. Initial failures and the failed dispatch run remain there. This temporary directory can be removed by the operating system; the compact evidence above is retained in this report directory.

The credential-free `codex-deepseek` launcher in this directory reads the separately configured local DeepSeek credential. From the `merv-typescript` directory, set `MERV_CODEX_BIN` to that launcher's absolute path and run the existing scripts with a **new output directory** each time:

```sh
node --import tsx scripts/live-codex.ts /private/tmp/NEW-user-keys --user-keys
node --import tsx scripts/live-sessions.ts /private/tmp/NEW-dispatch --automatic
node --import tsx scripts/live-experiments.ts /private/tmp/NEW-experiments --git
node --import tsx scripts/live-review-returns.ts /private/tmp/NEW-review-returns
```

These tests cover local SQLite, disk artifacts, native CLI agents and loopback MCP. They do not cover PostgreSQL, hosted production state, browser interactions, cloud GPUs, Nisa integration, or real Ledgerline fine-tuning. The tiny deterministic study is evidence of calculation and workflow behavior only. The negative review fixtures are intentionally obvious and include route semantics; they are not a blind benchmark of scientific review quality.
