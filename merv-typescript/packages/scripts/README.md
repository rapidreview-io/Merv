# Scripts

An agent connected from outside Merv (Claude Code, Codex, Cursor over MCP) writes one short
JavaScript program that makes many reads, in parallel, and gets back only what the program
returns. Reads only for now: the program can call no tool that writes, leaves Merv or shows a
secret.

| Entrypoint            | Requires       | Provides                     |
| --------------------- | -------------- | ---------------------------- |
| `@merv/scripts`       | nothing        | `scripts` service            |
| `@merv/scripts/tools` | Scripts, Tools | `script.run`, `script.tools` |

## Tools

`script.tools { query?, names?, limit? }` lists what this caller may use (as `tools/list` offers
it), each with `scriptable` and a TypeScript `declaration` of its input. With `query`, a ranking
over names and descriptions; with `names`, exactly those; with neither, each namespace with its
count and scriptable tools.

`script.run { code, timeoutMs? }` runs `code` as the body of an async function. In scope:
`tools.<namespace>.<name>(input)` for every scriptable tool, `call(name, input)` as the raw form,
and `console.log`. A refused or failed call rejects with an Error whose message is
`<code>: <message>`. The answer is `{ ok, result?, error?, logs, calls, truncated? }`; a failed
script's `error.code` is `script_syntax`, `script_error`, `script_timeout`, `script_memory` or
`script_call_limit`. `script_busy` (429) and `script_unavailable` (503) refuse the call itself.

A tool is scriptable when it is listed to this caller, registered `readOnly` (open-world reads
included: they keep their own budgets), not guarded for conversations (`never`, `propose`,
`secret`; a guard of the input is decided per call), and not `script.*`; a mounted tool needs
`readOnlyHint` and no destructive hint. A script makes only reads its caller could make one call
at a time. Each call is `invoke(name, caller,
input, true)` with the script's own caller, so every rule one call from this agent meets (role,
Access grants, Scope) applies to each. A native tool's project is the script's: a `projectId`
naming another is refused. A leased worker gets neither tool (`session_forbidden`).

## The sandbox

Each script runs in a new child process (`src/sandbox.mjs`, plain ESM, copied into `dist` by the
build) under Node's permission model, with an empty environment and reads allowed only of its own
file and the three QuickJS packages. Node 22's permission model walls off files, child processes
and workers, not the network; the child holds no credential to use it with. The child reports
whether the permission model holds it, and the parent runs no script otherwise. Inside, the
program runs in QuickJS compiled to WebAssembly, where `require`, `process`, `fetch` and
`setTimeout` do not exist; its only way out is a call message, which the parent validates (a fresh
integer id, a name of at most 128 characters, a JSON object input of at most 64 KiB) and kills the
child for anything else.

Limits: 50 calls per script, 4 in flight; 4 scripts per server process; 32 MiB of memory and 512
KiB of stack (the WebAssembly memory's maximum caps it, since this QuickJS build's own count
misses large strings and buffers); 1 MiB per call result; 32 KiB of result and logs back (cut with
`truncated: true`), 200 log lines of at most 2 KiB. The child is killed when the script ends, and
at the latest 1.5 s after its timeout.

`script.run` is registered `openWorld`, though it leaves Merv for nothing: a snapshotted read
would hold one reader connection for the whole run, while open-world each call inside reads on
its own snapshot.
