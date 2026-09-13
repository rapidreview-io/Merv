# Step 7 Claude Fable review

Status: **blocked before launch** on 2026-09-13. No Fable review was obtained,
no model result was returned, and no packet was sent by this attempt. This
record must not be counted as a completed independent model review.

The user requested Claude Fable consultation at significant development
milestones. Automatic approval review required separate authorization to send
this particular source packet to the external Claude service. No workaround,
indirect invocation, fallback model, or retry was used after the rejection.

| Metadata              | Observation                                                                             |
| --------------------- | --------------------------------------------------------------------------------------- |
| Requested reviewer    | `claude-fable-5`, explicitly pinned; no fallback configured                             |
| Installed CLI         | Claude Code `2.1.261` at `/Users/guraltoo/.local/bin/claude`                            |
| Execution outcome     | Rejected by automatic approval review before process creation                           |
| Actual model usage    | None; no model response or usage metadata exists                                        |
| Intended restrictions | Safe and restricted modes, all tools disabled, strict empty MCP, no session persistence |
| Baseline commit       | `7613264041ade8dddd650b9ceffba40270e427e5`                                              |
| Snapshot              | Uncommitted Step 7 Nisa integration; 24 files, 193,161 packet bytes                     |
| Private packet        | `/private/tmp/merv-step07-fable-toq4rly1/review-packet.md`                              |
| Private file manifest | `/private/tmp/merv-step07-fable-toq4rly1/manifest.json`                                 |

Packet SHA-256, verified against the saved packet immediately before invocation:

`252a425f5c6a46e12003521b90ca568e3439866f94a8d4224dcd00f3f04487e7`

Each included file's SHA-256 was also checked against the working source before
the attempted invocation. The snapshot includes the Nisa package; its live and
controlled unload harnesses; focused tests and synthetic Nisa/sandbox fixtures;
public API, Access, Credentials, and base contracts; the existing registry and
schema implementation; default composition; Nisa documentation; and the
sanitized controlled verification report. Existing boundary implementations are
labeled as unchanged context. It excludes real credential files, environment
files, saved profiles, runtime databases, `live-runs`, raw agent transcripts,
and sibling repository source. Credential strings in fixtures are synthetic.

The requested review would examine concrete high/medium correctness, credential,
request-boundary, lifecycle, and evidence defects, with source lines, triggers,
and meaningful regression tests. Fable would not be allowed to run tests, edit
files, access tools, or expand the packet.

At packet preparation, controlled fixture evidence recorded `29 → 27 → 29`
tools, admitted search draining after immediate withdrawal, native task/review/
feed continuity, and preserved independent sandbox connections. This was
explicitly labeled synthetic evidence. Actual Nisa service verification was
still pending in the packet; later live results are separate evidence and do not
change what this snapshot contains.

The rejected invocation was:

```sh
/Users/guraltoo/.local/bin/claude --print --model claude-fable-5 \
  --safe-mode --restricted --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' --tools '' \
  --no-session-persistence --output-format json \
  < /private/tmp/merv-step07-fable-toq4rly1/review-packet.md \
  > /private/tmp/merv-step07-fable-toq4rly1/response.json \
  2> /private/tmp/merv-step07-fable-toq4rly1/stderr.log
```

Automatic approval review's stated reason was:

> This sends a 24-file packet of potentially sensitive internal source code to an external Claude service; the user authorized consulting Fable but did not specifically authorize exporting this payload to that destination.

Completing this review requires user approval to send the exact packet and hash
above to Claude Fable. The prior Step 6 packet approval concerned a different
payload and was not treated as approval for this one.
