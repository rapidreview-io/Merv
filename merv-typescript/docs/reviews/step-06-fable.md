# Step 6 Claude Fable review: blocked before launch

Date: 2026-09-13. Requested review scope: the mounts implementation wave
`3bf8caf7..43b1bc32`. The later plan-only commit `47c00c62` records the user's
preference to consult Claude Fable at significant development milestones.

| Metadata                | Observation                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| Requested model         | `claude-fable-5`, pinned explicitly; no fallback configured               |
| Installed CLI           | Claude Code `2.1.261` at `/Users/guraltoo/.local/bin/claude`              |
| Model actually observed | None; invocation rejected before the process launched                     |
| Outcome                 | `blocked_before_launch`                                                   |
| Review feedback         | None; no Fable findings or approval were produced                         |
| Tool/MCP configuration  | Tools disabled; strict empty MCP configuration; safe and restricted modes |
| Session persistence     | Disabled                                                                  |
| Private packet          | `/private/tmp/merv-step06-fable-jj470mir/review-packet.md`                |
| Packet size             | 136,598 bytes; 19 focused source, test, and sanitized evidence files      |

The packet contains the current mounts runtime, scoped client pool, remote
catalog collector, public types, registry and schema boundary, access policy,
credential-provider implementation, focused mount/credential/permission/registry
tests, the existing-boundary diff, and committed controlled verification records.
Source lines are numbered for actionable findings. The packet excludes saved
credentials, environment files, private runtime state, and raw agent transcripts.
Synthetic fixture credentials appear only as test data.

Packet SHA-256:
`5e300d1eb09de2ad6cace72c5818f4747932af6795b45dcacd1f7633967cc2db`.

The request asks for concrete high/medium correctness, security, or lifecycle
bugs with file/line, exact trigger, mechanism, and a meaningful regression test.
It explicitly distinguishes the reported 160 passing deterministic checks and
controlled `27 → 26 → 27` mount-removal proof from the still-pending authenticated
real-service/real-agent gate. Fable was not asked to edit files, execute tests,
make external requests, or advance the execution plan.

The attempted command was:

```sh
claude --print --model claude-fable-5 --safe-mode --restricted \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools '' \
  --no-session-persistence --output-format json \
  < /private/tmp/merv-step06-fable-jj470mir/review-packet.md \
  > /private/tmp/merv-step06-fable-jj470mir/response.json \
  2> /private/tmp/merv-step06-fable-jj470mir/stderr.log
```

Automatic approval review rejected the command before launch with this reason:

> Although the user authorized Claude Fable milestone reviews, this command
> uploads a substantial private source-and-test packet to an external model
> service without specific approval for that payload's disclosure.

No packet was uploaded, no model process started, and no saved sandbox token was
accessed. The remaining authorization is permission to send this concrete
source-and-test packet to Claude Fable for the requested read-only review. This
record must not be counted as a completed external review or as Fable's approval
of the implementation. No alternate model or indirect retry was used.
