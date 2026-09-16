# Runner control plane

Workflows selects eligible assignments. Sessions reserves them, tracks runner
presence and applies project dispatch controls. The optional `sessions-api` and
`sessions-ui` adapters expose those operations through the existing API and UI.
There is no additional scheduling provider and no Sessions dependency on Tasks,
Reviews or Feed.

```mermaid
flowchart LR
  Human[Project operator] --> UI[Sessions UI]
  UI --> API[Sessions API]
  Machine[Machine runner client] --> API
  API --> Sessions
  Sessions --> Workflows
  Workflows --> Programs[Registered program admission hooks]
  Sessions --> State[Durable leases and presence]
  Sessions --> Scope[Source authority and worker identity]
```

This diagram shows responsibility and requests, not Cordis dependencies. The
[dependency inventory](architecture/current-dependencies.json) records actual
`inject` declarations.

## Assignment selection

`Workflows.dispatchCandidates(source)` returns source-authorized metadata for
leaseable nodes: instance and revision, program and state, worker role, label,
fixed execution policy hash, registration generation and workspace declaration.
Read-only nodes sort first, followed by stable creation/ID order.

The domain program decides whether this source may take the assignment. Required
work-item dependencies and recipe availability still apply. Candidate discovery
does not render the assignment, load artifact contents, resolve reference values
or record work starting. A candidate is a hint; issuing a lease rechecks current
authority, ownership and revision transactionally before freezing the packet.

Sessions removes already-leased targets and applies runner/platform capacity and
launch-failure backoff. Offered leases reserve capacity before activation. An
automatic lease requires a fresh source-bound runner registration. An explicit
manual offer retains its existing semantics and does not require automatic
dispatch to be enabled.

## Pause and halt

Automatic dispatch starts **off** for every project. Enabling it allows a
registered machine to request work; it does not start a local process by itself.

| Control          | New automatic assignments                               | Existing sessions                              |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------- |
| Enable dispatch  | Allowed if the source, runner and workflow are eligible | Continue                                       |
| Pause dispatch   | Refused                                                 | Continue                                       |
| Halt one session | Other assignments remain enabled if previously enabled  | Selected session closes permanently            |
| Halt project     | Disabled in the same transaction                        | All current project sessions close permanently |

Closing retires the leased worker, retaining its source account/key and prior
work. Durable domain events release exact ownership handles for a successor.
A machine-side runner must observe closure and stop its child; the server cannot
prove that a process on another machine has stopped merely by closing a lease.

## HTTP and browser controls

These routes use ordinary authenticated source credentials, never an agent's
MCP-only session secret. Operator controls require project administration.

| Method and route                     | Purpose                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `GET /sessions/status`               | Sanitized project session history, runner presence and caller-eligible queue |
| `PUT /sessions/dispatch`             | Set `{ enabled }`                                                            |
| `POST /sessions/halt`                | Disable dispatch and halt project sessions                                   |
| `POST /sessions/:id/halt`            | Halt one project session                                                     |
| `POST /sessions/runners/heartbeat`   | Register or refresh this source's machine inventory and capacity             |
| `PUT /sessions/runners/:id/settings` | Set desired platform enablement, model, effort and parallelism               |
| `POST /sessions/lease`               | Select and reserve one eligible assignment for a registered platform         |

The existing offer, attach, heartbeat, release and exact-source inspection routes
are described in [SESSION_LEASES.md](SESSION_LEASES.md). Project status and halt
are separate project-authorized operations: a human operator can inspect and stop
machine-key jobs without impersonating the key that issued their leases.

Runner settings contain bounded platform metadata. Executable paths, arbitrary
arguments, bearer credentials and shell commands cannot be installed through
these HTTP settings. Local launch profiles will own executable configuration.
Settings acknowledgement reports what the machine says it has applied; the
server still enforces current desired limits when issuing work.

The Sessions page uses `ui.read` for its data and authenticated HTTP for operator
controls. It shows dispatch, connected runners, leases, workspace attachments and captured commits, and available work.
Removing `sessions-ui` removes that page; removing `sessions-api` removes its
HTTP controls. Neither adapter owns durable records or adds agent tools.

## Workspace declarations

Workspace rules are part of the fixed execution policy owned by each assignment
type. They are not separate task-type plugins.

| Mode         | Intent                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `none`       | Scratch space without a repository checkout                                                                             |
| `ephemeral`  | Temporary checkout from central or an explicitly named reference                                                        |
| `persistent` | Per-instance checkout, with declared retention, optional per-base identity and a reserved `advancesCentral` declaration |

Namespaces must be safe single path segments. A referenced base names an entry in
the frozen execution references; it must never silently fall back to central if
missing. A read-only assignment cannot declare central publication. The machine
Runner implements [Git resolution, preparation and capture](WORKSPACES.md), plus
the fixed [Code commit protocol](CODE_OPERATIONS.md).
Declaring `advancesCentral` does not itself publish a commit; the reviewed
publication protocol remains open.

Omitted workspace policy means `none` through `effectiveWorkspace()`. That default
is not materialized into old manifests, so existing pinned policy hashes and Task
versions remain valid. New explicit declarations participate in policy hashing.

## Worker code operations

The independent Code provider depends on State, Scope and Sessions. Its tool
adapter exposes `code.commit` and `code.operation`; its HTTP adapter exposes
source-owned command retrieval and completion. It does not schedule assignments
or launch another process. The existing machine Runner polls the durable queue
and executes a fixed commit operation against its owned checkout.

Only a live writable session with an explicit `code.commit` grant and an attached
Git workspace can queue a request. The worker supplies an expected HEAD, message
and request ID, never a path or Git command line. Runner reports an immutable
operation receipt before the worker's handoff; final stopped-worker capture is
a separate Session result. Read-only workers cannot request commits.

Command retrieval and completion use the original source credential, not the
worker credential. Already-dispatched commands remain recoverable after lease
closure, so lost replies cannot strand an unknown outcome. Closed queued work
is cancelled; recovery never reactivates the worker. The Code page displays
operation status through its optional UI adapter. See [CODE_OPERATIONS.md](CODE_OPERATIONS.md).

## Remaining runner work

The [machine Runner](MACHINE_RUNNER.md) now consumes these controls through HTTP
with durable launch intent, private secret derivation, owned process groups,
offline deadlines and controller restart reconciliation. Native Codex profiles
support bounded local shell work and enforce read-only assignment policy.

Git base resolution, persistent/ephemeral checkouts, fixed live commit requests,
immutable operation/capture receipts and acknowledged cleanup are integrated. Sessions accepts attachment and final metadata
from the exact source/runner/host through its HTTP adapter; it owns no filesystem
paths or Git operations. A final report may arrive after lease closure without
reviving that lease. Domain Events delivers the captured result to interested
programs. See [workspace ownership and recovery](WORKSPACES.md).

`code.propose`, general merges, durable reviewed publication, cross-machine Git object transport, machine pairing,
source rotation, editable operational settings, trace delivery and telemetry remain
open. The historical native Git capture acceptance uses one machine and a
synthetic managed workflow; it predates Code operations and does not establish
those remaining capabilities. New Code acceptance is recorded separately.
