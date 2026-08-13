# Hermes Agent

## Hosted setup

```bash
hermes plugins install rapidreview-io/merv-hermes-client --enable
hermes mcp add merv --url https://experiments.rapidreview.io/mcp --auth oauth
```

Approve **All my projects** in the browser. The native plugin registers every
canonical Merv skill under the `merv:` namespace. No clone or Merv key is
needed.

The generated repository checks Merv's `main` branch every five minutes and
rebuilds itself when it changes. Hermes does not pull third-party Git plugins
automatically, so run this when Merv announces an update:

```bash
hermes plugins update merv
```

## Runtime behavior

Hermes exposes remote tools as `mcp_<server>_<tool>`. For example,
`workflow.status_and_next` is available as
`mcp_merv_workflow_status_and_next`. Apply that same translation to every
public tool named by a canonical skill or handoff prompt—for example,
`review.start` becomes `mcp_merv_review_start`. Runner-owned Hermes sessions
use `merv-client call` with the original public tool name instead.

After `review.request`, pass `reviewer_handoff.spawn_prompt` unchanged to a
fresh `delegate_task` child. The child must call `review.start` with its own
non-empty `caller_session_id`; the producer must not submit its own review.

For a project-reflection wave, launch the five independent lens prompts with
`delegate_task(tasks=[...])`. Hermes defaults to three concurrent delegated
tasks, so five lenses normally run in two waves unless the user changes the
delegate-task concurrency setting.

For long sandbox work, start `merv-runs-wait --url <wait_url>` through Hermes'
background terminal with completion notification enabled. When it exits,
re-read `sandbox.runs`; the watcher wakes the agent but is not the source of
truth.

## Use with the local agent runner

```bash
merv-client agent hermes --enable --command hermes
# Optional model override:
merv-client agent hermes --model anthropic/claude-opus-4-6
```

The runner invokes `hermes -z <instruction>`. Hermes does not expose a per-run
MCP configuration flag, so claimed sessions use the scoped `merv-client call`
fallback included in their instruction. The runner scrubs ambient `MERV_*`
credentials and gives the child only its short-lived
`MERV_AGENT_SESSION_KEY`; it does not pass that credential on argv.

Hermes scripted mode accepts its prompt only as the `-z` argument, so the work
instruction is visible in the local process list even though it contains no
Merv credential. Use separate OS identities or containers when same-machine
research context itself requires isolation.

## Local development or headless setup

The legacy installer remains available from a Merv checkout or slim-client
bundle:

```bash
./clients/hermes/install.sh
```

It links the canonical skills into `${HERMES_HOME:-$HOME/.hermes}/skills`.
For a headless profile, export `MERV_MCP_KEY` and add:

```yaml
mcp_servers:
  merv:
    url: "https://experiments.rapidreview.io/mcp"
    headers:
      Authorization: "Bearer ${MERV_MCP_KEY}"
```
