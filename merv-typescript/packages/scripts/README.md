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
included: they keep their own budgets) or with `reads` (then only a call whose input it says
reads, such as `sandboxes.sandbox` or `fleet` with action=list), not kept from conversations (`never`), and not
`script.*`; a mounted tool needs
`readOnlyHint` and no destructive hint. Discovery only shapes `tools`: each call is
`invoke(name, caller, input, true, admit)` with the script's own caller, and the registry runs
`admit` on the registration that will run it, where caller rules admit it, so a tool re-registered since is judged as it is now. Every rule one call from this agent
meets (role, Access grants, Scope) applies to each. A native tool's project is the script's: a
`projectId` naming another is refused. A leased worker gets neither tool (`session_forbidden`).

## The sandbox

Each script runs in a new child process (`src/sandbox.mjs`, plain ESM, copied into `dist` by the
build) under Node's permission model, with an empty environment, reads allowed only of its own
file and the three QuickJS packages, and its own process group, which teardown kills whole. The
child reports whether the permission model holds it, and the parent runs no script otherwise;
any other message first ends it as `script_unavailable`. Inside, the program runs in QuickJS
compiled to WebAssembly, where `require`, `process`, `fetch` and `setTimeout` do not exist.

The child has no IPC channel: the two speak length-prefixed JSON frames over stdin and stdout. The
parent refuses a frame over 1 MiB from its length before buffering it, parses each under a catch,
and ends the script (`script_error`) for anything a sandbox would not send. A call must carry a
fresh integer id, a name of at most 128 characters and a JSON object input of at most 64 KiB; a
larger input is refused inside the child, where the script can catch it
(`script_input_too_large`).

Limits: 50 calls per script, 4 in flight; 4 scripts per server process, a script holding its slot
until every host call it started has settled (after it ended or timed out too); 8 host calls in
flight across all scripts, queued beyond; 32 MiB of memory and 512 KiB of stack (the WebAssembly
memory's maximum caps it, since this QuickJS build's own count misses large strings and buffers);
1 MiB per call result; 32 KiB of answer, measured as UTF-8 bytes of its JSON however the script
ended (result first, then logs; cut with `truncated: true`), 200 log lines of at most 2 KiB. The
child is killed when the script ends, and at the latest 1.5 s after its timeout.

### What is not contained

Node's permission model is no sandbox against malicious code in the process, and the child runs
as the server's own user. Its code is ours; a script reaches it only by escaping QuickJS's
WebAssembly sandbox first. A script that did could then reach the network (internal services,
metadata endpoints; the child holds no credential to use with them) and signal the server's
processes. Containing that needs the child under a separate identity, in its own network
namespace, or in a container.

`script.run` is registered `openWorld`, though it leaves Merv for nothing: a snapshotted read
would hold one reader connection for the whole run, while open-world each call inside reads on
its own snapshot.
