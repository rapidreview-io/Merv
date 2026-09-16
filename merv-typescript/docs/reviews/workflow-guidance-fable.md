# Workflow guidance: Fable review pending approval

External review status: **not performed**. Automatic approval review rejected the
invocation before process creation. No Claude result, model-usage evidence or
Fable findings exist for this checkpoint. The packet has not been retried or
changed. Ongoing development may change the worktree; approval would apply to
this exact frozen snapshot, not later code.

| Evidence               | Value                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Requested reviewer     | `claude-fable-5`, explicitly pinned; no fallback                                                 |
| Installed CLI          | Claude Code `2.1.261` at `/Users/guraltoo/.local/bin/claude`                                     |
| Packet creation        | `2026-09-15T01:46:12.127474+00:00`                                                               |
| Baseline commit        | `be69497bbb97c8063b850fb937f56e1dba51cf80`                                                       |
| Packet                 | 19 complete source, test and documentation files; 222,526 bytes                                  |
| Packet SHA-256         | `a7223220b016a6f5cab906a30dddf628f5b2ed8698de57c7457677fb86c42224`                               |
| Manifest SHA-256       | `408a2456bb97173d9acd361c73d1efae3fd68dd12d892d91985ba2711be1a753`                               |
| Packet location        | `/private/tmp/merv-guidance-fable-kr6aqxum/review-packet.md`                                     |
| Manifest location      | `/private/tmp/merv-guidance-fable-kr6aqxum/manifest.json`                                        |
| Requested restrictions | Safe and restricted modes; tools disabled; strict empty MCP; no session persistence; JSON output |

The packet contains guidance contracts, Workflows evaluation and engine, Tasks
rules and adapters, Reviews validators, State/Scope transaction and permission
context, focused tests and the guidance design document. It excludes credential
and environment files, runtime databases, profiles, live-runs, previous model
transcripts, sibling repositories and unrelated source. Source lines are numbered
for exact review references. The packet remains local in `/private/tmp`.

The automatic approval review stated:

> This sends a 222 KB packet of private source code and tests to an external Claude service; the user authorized consulting Fable but did not specifically authorize exporting this payload to that destination.

The review can proceed only after explicit approval to send this exact packet to
Claude. Its hash must be reverified before a retry. The attempted command was:

```sh
/Users/guraltoo/.local/bin/claude --print --model claude-fable-5 \
  --safe-mode --restricted --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' --tools '' \
  --no-session-persistence --output-format json \
  < /private/tmp/merv-guidance-fable-kr6aqxum/review-packet.md \
  > /private/tmp/merv-guidance-fable-kr6aqxum/response.json \
  2> /private/tmp/merv-guidance-fable-kr6aqxum/stderr.log
```

## Independent local review and correction

The Codex review agent separately inspected the frozen source locally. This is
**not Fable feedback**. No material transaction, tenant-isolation or review-claim
regression was established by that bounded source inspection; this is not a
claim of exhaustive verification.

A concrete P3 compatibility defect was reproduced: `validatePolicy` reused the
workflow identifier pattern for `action.tool`, rejecting valid mounted tool names
such as `_nisa.ask` with `invalid_workflow_policy`. Tools publishes names beginning
with a letter, digit or underscore; the policy validator accepted only a letter.
This prevented a program from advertising a mounted tool as a next step, while the
current native task flow was unaffected.

The local correction adds a separate tool-name pattern matching the registry's
published-name contract, without adding an API dependency to Workflows. The
focused regression verifies guidance preserves `_nisa.ask`, a nested mounted
name, a leading-digit native name and a 128-character name. Whitespace, slash,
colon, empty and oversized names remain rejected. Naming a tool in a policy does
not publish it or dispatch a remote call; permissions remain checked by Tools.

Validation: `node --import tsx --test tests/workflow-mounted-guidance.test.ts`
passed one test with zero failures and skips. Both edited files were formatted.
This correction is **after** the frozen packet and would not be covered by a
review of that original packet.

## Frozen file hashes

| File                                          | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `packages/contracts/src/data.ts`              | `6d8ab453bf91a98749b33a8bc4d22f23f076cbb94447693775962d8d3dc99ddd` |
| `packages/contracts/src/workflow-guidance.ts` | `09f6438f7588d3106fc6cf8dc697d1dc07113275319b46e4b5a8485d283e6ce2` |
| `packages/contracts/src/index.ts`             | `4c70fb6ddedd8caa7ce3f531434134258d26af521991b9e958915920dbb5d30b` |
| `packages/workflows/src/definition.ts`        | `16d1fc7e02ac8258426f0e36cd4dd5c1e88963f9ac5c92a95201bd9f4228810b` |
| `packages/workflows/src/evaluation.ts`        | `9fcf6b78d72a62e8cdcb98bc39d7d6be04e361c1e49be7d40b4b311362ca88f4` |
| `packages/workflows/src/index.ts`             | `3b16e20d255a9c21c268fb0f3c92ba240691be3fe7cbecf3baead3286f12d116` |
| `packages/workflows/src/tools.ts`             | `54fcc54f100d5df8b3208c03d5618c6431c0a8322416e8699875eb0d20d60a86` |
| `packages/tasks/src/definitions.ts`           | `f4474e6eb25009d7a254135ea44f74c2df51dfec14f445007bab2e7063c2c567` |
| `packages/tasks/src/index.ts`                 | `1224421470cc47524f2687ff46f81c167243b82f8ffdb65cb00677e8e10976fc` |
| `packages/tasks/src/tools.ts`                 | `59ce90bea91b886a5d397e44757d09f05ddfe0b5fde76a7a64328b29de5189dd` |
| `packages/reviews/src/index.ts`               | `2eb6c2f95a1d200b5de0884139816d6e3e38f159f33728de6442aec02c955845` |
| `packages/reviews/src/tools.ts`               | `fe1405ede8054d75e8479111d89500009ed55c861472a2ecc9a2456d6e00ae3f` |
| `packages/state/src/index.ts`                 | `e04d2a715fb9825240bc240d7d0b5c1a92d9da6614c9e7040f6fc93f71ec3d32` |
| `packages/scope/src/index.ts`                 | `85cf1dc8b5d41777613a11cf43702153cb134ddbc1c39c73c45695c53932bd32` |
| `tests/workflow-guidance.test.ts`             | `6dcf8bcbfe685190b48367e9db8b858c47072f2ad6b111cf219c9158bb99c3dd` |
| `tests/workflows.test.ts`                     | `8557b3b76e317edd7f22e43c2e90c2a764ae3e24bd0de10d92b8a0e9ebfcddde` |
| `tests/workflow-unload.test.ts`               | `fa7311efedb639b1968e9e8956fa2e9fb298dd813fc5b66f3420d97dae423d1c` |
| `tests/app.test.ts`                           | `5a4269757ca9839bbbf44e858d6e7265b0adc38d884be6d3e79f573b42684931` |
| `docs/WORKFLOW_GUIDANCE.md`                   | `910e8082a369b759ec92374ad7c0ddfdb08bba3cde9743e0b010dc2cbaed545a` |
