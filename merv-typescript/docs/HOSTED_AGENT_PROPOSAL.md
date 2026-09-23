# Optional hosted Pi agent — implementation proposal

> Historical proposal, superseded by [Optional Fleet and Pi agent](FLEET_PI_PROPOSAL.md). The current design separates shared compute into an optional Fleet plugin and makes the Pi package depend on it. Use the newer proposal for implementation planning.

Status: design only. No implementation or deployment is authorized by this document. Prepared 2026-09-23 from the current Merv checkout, the sibling merv-sandboxes checkout, and current upstream documentation.

**Decision.** Run Pi in a dedicated Cloudflare sandbox obtained through the existing Merv Sandboxes feature. Keep the main Merv VM responsible for authentication, conversations, scheduling decisions and durable state. Use one optional hosted-agent package and one Pi worker package. Do not add another Cloudflare client, another infrastructure broker, a generic harness framework, or a second assignment scheduler.

The user's clarification that Cloudflare will be accessed through our own Sandboxes feature makes that the preferred first production path. A separate shared worker VM is not a prerequisite. Local execution is a development/test fixture only; no automatic fallback to running model-generated code on the main application VM.

**Hosting decision.**

| Choice | Benefit | Cost or limitation | Decision |
|---|---|---|---|
| Pi processes on the main application VM | Fewest provisioning steps | Resource contention with API/database; process separation alone does not isolate users or shell access | Do not use for shared production execution |
| Separate worker VM with isolated runtimes | Predictable startup and fixed capacity | Another fleet to operate, provision and size | Reconsider only if measured sustained utilization justifies it |
| Cloudflare through our Sandboxes service | Existing provider/lifecycle, independent runtimes, capacity allocated on demand | Startup/restore latency, ephemeral disks, explicit retention and release | Recommended |

Cloudflare exposes managed Containers rather than a conventional VM provisioning API. Our existing provider already hides this distinction. The hosted plugin should request a configured sandbox offer and observe its readiness, not know Cloudflare's Worker or Durable Object APIs. Cloudflare documents variable cold starts, often 1–3 seconds; full Merv readiness also includes the reverse tunnel, runtime staging, checkpoint restoration and Pi initialization. Measure that complete path before promising a startup time. [Cloudflare FAQ](https://developers.cloudflare.com/containers/faq/)

**Existing capabilities and exact gaps.**

- `packages/sandboxes/src/types.ts` and `checks.ts` already provide a server-owned example of idempotent sandbox acquisition, artifact staging, jobs, observation and release. The check abstraction is specifically a bounded command/verdict; do not make interactive chat pretend to be a Code check.
- The sibling `merv-sandboxes/docs/providers/cloudflare.md` documents Cloudflare tunnel access, operation-ID recovery, fixed deployment shape, leases and verified historical stage/run/capture/release workflows. That is implementation evidence, not a fresh production readiness check.
- The existing Cloudflare bridge deliberately keeps its Durable Object resident while a container runs. Our service must release idle capacity explicitly; generic Cloudflare automatic sleep is not the application lifecycle.
- `docs/AGENT_CONTINUITY.md` provides stable agent identity and assignment-specific execution. Idle agents have no domain MCP authority. Conversational planning needs an explicit bounded delegation; it cannot borrow an assignment token or silently acquire operator permissions.
- Runner currently launches one process for one frozen assignment. Keep that behavior. Add a narrow Pi launch profile for assigned work only when the workflow integration phase requires it; do not refactor Runner into a chat server.
- UI rows are registered dynamically, but the browser renderer is compiled. Add one conversation view to the existing browser registry and register its row only when the hosted plugin is present.

**Small package and ownership boundary.**

| Owner | New responsibility |
|---|---|
| `@merv/hosted-agent` | Conversation records, turns, durable events, runtime binding, reconciliation and quotas |
| `@merv/hosted-agent/api` | Human conversation controls and narrowly authenticated worker channel |
| `@merv/hosted-agent/ui` | Agent sidebar registration; page consumes hosted APIs |
| `@merv/pi-worker` | Pinned Pi SDK, Merv MCP bridge, message/event transport, checkpoint serialization |
| Existing Sandboxes provider | Add a small server-owned runtime capability alongside checks: acquire, stage/start, inspect, renew, stop/release |
| Existing Scope/Sessions | Minimal bounded coordinator delegation; existing assignment authority and provenance |
| Existing Code/Runner | Assigned repository/workspace work and capture, after read/chat pilot |

The API/UI entries are subpath plugins of the hosted-agent package, not independent products. Pi is an ordinary dependency of the worker package and is absent from the core server dependency closure. All proposed names are illustrative until implementation.

The runtime capability must use the existing consumer namespace connection and service transport. It is an internal capability, not a new model-callable machine-provisioning tool. It accepts a configured profile, project ownership, durable operation key, release identity, bounded lease, and approved runtime artifact reference. It must not accept a model-selected executable, provider secret, image URL, namespace or arbitrary bootstrap script. Internally it can compose existing sandbox and job endpoints; add service endpoints only for missing guarantees established in phase 0.

The hosted plugin may depend on Sandboxes; no core research plugin may depend on Hosted Agent. Optional dependency failure leaves the research application usable. When runtime capacity is unavailable, retained conversations remain readable and sending a new turn reports unavailable or queued. Disabling/uninstalling the plugin removes its row and routes but retains its data. Finite sandbox leases provide cleanup even if the plugin process disappears.

**Runtime allocation and lifecycle.**

Allocate per conversation, within a fixed user and project. Initially allow one active conversation per user and one turn at a time per conversation; other conversations remain durable and cold. This avoids cross-project context/credential reuse and makes concurrency explicit. A reviewer gets a separate execution, identity and sandbox. Expand per-user concurrency only after measurement.

Start on the first accepted prompt, not on login or opening the page. Opening history needs no runtime. Browser disconnection does not cancel work. Retain a running turn until its deadline, explicit stop, revoked authority or budget refusal. After Pi is idle, no child work is running, and the checkpoint is acknowledged, retain the runtime for a configurable grace period; propose five minutes initially. Polls, browser presence, runtime heartbeats and transcript reads do not reset this grace timer.

Persist these runtime states: `absent → provisioning → restoring → ready → running → idle → checkpointing → releasing → absent`, with `failed` and `uncertain` branches. A new prompt racing with release must either cancel release before its committed boundary or wait for a new runtime epoch. It must never land on a half-destroyed runtime.

Acquisition keys derive from conversation ID and runtime epoch, so retrying a lost response cannot rent twice. Store the intent before requesting capacity. Store sandbox and job handles immediately on acknowledgment. A reconciler recovers ambiguous operations through the service's idempotency/operation identity; it does not invent a new key. Stale epochs cannot submit events, renew credentials or execute new Merv calls. Do not start a successor until old authority is fenced and old process/workspace ownership is resolved; uncertain capacity remains visible and counted.

Use finite renewable sandbox leases with a configured maximum lifetime. The effective run deadline is the earliest of hosted turn deadline, delegated authority expiry, assignment hard deadline when applicable, and sandbox lease deadline minus a capture margin. Renewal is control-plane work. On source revocation, revoke worker authority immediately, request cancellation/release, and let the finite lease bound orphaned compute. An already admitted remote operation may finish; record and reconcile it rather than claiming rollback.

**Deployment and worker communication.**

Initially stage a versioned, digest-verified runtime archive through existing sandbox storage/job facilities. Include the compatible Node runtime, pinned Pi, bridge and dependencies for the selected Linux architecture; do not run an unpinned npm install on every startup. Phase 0 verifies executable compatibility and archive size. Run a fixed launcher as the sandbox job with a bounded timeout and retained diagnostic logs.

This avoids changing the shared Cloudflare image for each Pi release. Our Cloudflare provider's current image rollout procedure requires draining the control installation and can replace running containers; pre-baking Pi is an optional later optimization, not a reason to introduce an unsafe image rollout. Runtime upgrades apply to new allocations and do not change live conversations in place. Pin checkpoint format and worker release together; refuse an unsupported restore instead of dropping history.

The Pi worker initiates outbound HTTPS to Merv, pulls queued turn/control commands, and posts batched events with sequence numbers. The browser talks only to Merv: authenticated POST commands and a resumable event stream using its existing auth mechanism (fetch streaming if bearer headers are required). No new public port, browser-to-sandbox connection, or SSH key belongs in the browser. Keep raw text deltas ephemeral; retain completed messages and tool lifecycle records before reporting durable completion. Bound queues and event sizes to prevent a slow browser from retaining unlimited memory.

Provisioning authorization remains on the control plane. A bootstrap secret is single-use, short-lived and bound to project, conversation, sandbox and epoch; exchange it for a limited worker channel credential. Use a protected delivery mechanism, never command text or job logs; if current job staging cannot deliver secrets safely, that is an explicit phase-0 service gap. Worker credentials permit only its command/event/checkpoint channel and current tool grant. Sandboxes provider keys, project consumer grants and ordinary source credentials never enter Pi's environment.

Model credentials also require a deliberate boundary. Prefer a narrow authenticated model gateway holding provider keys server-side, with model allowlists and request limits. If an initial private pilot injects a restricted provider key instead, treat every enabled shell command as able to read it and document that pilot limitation. Public rollout requires scoped/revocable access and tested separation from provider administration credentials.

**Authority and tool use.**

Pi custom tools forward through Merv's authenticated MCP boundary. The bridge discovers current tools, handles schemas/results/errors and cancellation, and refreshes on catalog changes; Merv remains authoritative when stale tools are invoked. Mounted Nisa/Sandboxes tools keep existing source grant checks. No direct database access or privileged in-process domain calls from Pi.

Read-only chat is the first user-facing slice. Add explicit coordinator delegation for the full product: project, source membership epoch, stable actor, expiry, allowed tools and argument constraints. Validate this delegation at discovery and every dispatch; reuse existing source-revocation machinery. Authorize only the coordinator operations needed to inspect research and create permitted work. This is a minimal extension of existing authority contracts, not a second permissions system. Existing credential-free service actors must not be issued credentials as a shortcut.

Assigned execution remains separate. A trusted controller obtains the frozen assignment and starts a distinct worker with only assignment authority. The conversational coordinator can request work; server-side admission decides whether another worker may start. It cannot hand its broader credential to an assignment worker. Review independence uses existing stable actor rules. Do not synthesize a workflow assignment for every chat message.

In early phases, disable Pi shell/file tools and arbitrary extension discovery. Add coding only inside an owned sandbox workspace with existing Code/Runner capture semantics. Heavy training, GPU jobs and long-lived research compute continue through the existing research Sandboxes path; they are not run on the small interactive agent machine.

**Durable state and recovery.**

Use existing State for metadata and existing blob storage for opaque Pi checkpoints/attachments. Minimal tables: conversations (project, owner, ACL policy, revision, current runtime binding/checkpoint); turns (client request key, state, deadline, source, usage); events (conversation/turn/sequence/kind/body); runtimes (epoch, sandbox/job/operation IDs, lease, release/checkpoint state). Worker execution references point to Sessions records; they do not duplicate workflow state.

Conversations are private to their owner initially, with project membership still required. Project-wide sharing is deferred. Generated research artifacts retain existing project permissions. Every history read, send, stop, stream and attachment fetch enforces ownership and current membership; conversation IDs are not capabilities.

Persist the user message and enqueue intent atomically before acknowledging send. Use a transactional outbox or the same durable state machine, not an extra queue product. A worker appends events idempotently under its epoch. Store Pi session data including compaction and branch state, not just a rendered transcript. Upload an immutable checkpoint, verify its digest, then transactionally advance the checkpoint pointer. Only after that acknowledgment may normal idle teardown occur.

Persist checkpoints at turn boundaries and before releasing capacity. Retain tool invocation intent/outcome and the last committed Pi state during a turn where the SDK permits. A hard crash may lose unfinished text or leave a side effect uncertain; mark the turn interrupted. Resume from the last consistent checkpoint and reconcile Merv domain state. Never replay an ambiguous mutating tool merely because the conversation checkpoint predates it. Reuse request IDs where the underlying operation supports idempotency; otherwise require reconciliation before continuing.

Workspace files need their own retention path: Code capture/receipts for repository state, artifact uploads for outputs, and snapshots only where supported. A Pi checkpoint is not a filesystem snapshot. Refuse clean idle release while unretained writable work exists; unexpected loss is reported honestly. The initial tool-only pilot avoids this workspace retention complexity.

**Phased delivery.** Each phase is independently reviewable; keep public admission off until phase 5.

| Phase | Work | Exit evidence |
|---|---|---|
| 0 — Prove the existing sandbox path | Use a disposable sandbox to validate configured Cloudflare offer, tunnel/job readiness, pinned runtime staging, Node/Pi launch, outbound connectivity, protected bootstrap, stop and release. Inspect job timeout/renewal limits. Measure full ready time and baseline memory. No UI work yet. | One cold start and fresh allocation restore; retained output readable after release; no orphan machine; explicit list of missing service guarantees |
| 1 — Durable optional shell | Add hosted package, migrations, conversation API and UI row/page. Use a deterministic fake worker. Implement auth, idempotent send, ordered events, stop and optional absence. | Plugin absent/disabled leaves external MCP workflows intact; wrong-owner/project requests denied; reconnect replays committed events once; duplicate send creates one turn |
| 2 — Private Pi chat pilot | Add worker package, sandbox runtime capability, fixed runtime artifact, narrow MCP bridge and read-only coordinator grant. Integrate sandbox acquisition/release, streaming, cancellation and remote checkpoints. | Real read-only Merv query; disconnect during response; stop; restart Merv and worker separately; destroy/recreate sandbox and restore history; no duplicate allocation or token leakage |
| 3 — Research actions and assignments | Add bounded coordinator writes and source revocation; separate assignment workers with existing Sessions/Workflows. Add narrow Pi Runner launch support only for these workers. Start with one real task/review loop. | Hosted producer and external reviewer, then external producer and hosted reviewer; self-review rejected; source revoked mid-run; assignment policy enforced; successful process exit alone cannot close a workflow gate |
| 4 — Coding and reliable shutdown | Enable bounded shell/file tools only in assigned workspaces. Reuse Code capture/receipts. Complete workspace retention, uncertain side-effect recovery, release races, child-work cancellation and orphan reconciliation. | Writable change survives deliberate teardown; worker loss never silently reports success; stale epochs cannot mutate; uncertain termination does not launch a competing owner |
| 5 — Multi-user rollout | Enforce per-user/project/global admission caps, queue fairness, model limits, sandbox budget checks, explicit idle release and metrics. Start with invited users and low global cap, then increase based on evidence. | Cross-user isolation; capacity exhaustion queues cleanly; provider failures leave core UI responsive; measured startup/concurrency cost; no leaked runtimes after crash/disable; successful rollback preserves conversations |

Phase 0 is a future implementation/acceptance task, not a sandbox launch performed for this proposal. Paid provisioning is not performed here. Phases 1–2 deliver the smallest useful experience. Phases 3–4 complete the requested alternative to an external coding agent. Do not call the read-only pilot the complete product.

**Initial limits and observable behavior.** Proposed starting defaults, to tune after measurement: one active conversation per user; one active turn per conversation; four active hosted runtimes globally during the private pilot, including reviewers; five-minute post-work idle grace; 15-minute interactive turn deadline. All are configuration, not measured capacity or restrictions on existing external clients. Background workflow work uses its own explicit deadlines and consumes the same global capacity.

Queue by user fairly and keep queue position visible. Register state changes rather than maintaining a model loop for queued work. Show `Starting`, `Restoring`, `Working`, `Stopping`, `Interrupted`, and `Waiting for capacity` accurately. Display links to the existing Sandbox and Sessions records. A Stop action stops the current hosted work; ending an unrelated research job requires its own explicit operation.

Track startup stages/p50/p95, active runtime count, queue wait, sandbox lifetime, productive versus idle minutes, model usage, checkpoint latency/failures, interrupted turns and unreleased resources. Existing Sessions cost fields are self-reports, not authoritative billing. Use reservations, maximum request output, turn limits and provider-side limits for enforcement; do not promise exact dollar caps solely from after-the-fact token reports.

**Cost and capacity decision.** Cloudflare bills provisioned memory/disk while running plus actual CPU, with separate Workers/Durable Objects/network charges. At published rates, `standard-1` (4 GiB, 8 GB, 0.5 vCPU) is approximately $0.038/hour before CPU and $0.074/hour at full CPU utilization. As an illustrative calculation, 2,000 runtime-hours/month is about $76–148 of container compute, before other services, model tokens, allowances and idle-grace overhead. This is not an end-to-end quote. Our sandbox offer table uses maximum CPU for its compute estimate. [Pricing](https://developers.cloudflare.com/containers/platform/pricing/)

The configured Cloudflare bridge currently fixes one shape per deployment; selecting a smaller type may require an infrastructure deployment, not a per-user request. Start from the verified configured offer and measure before changing it. Use active runtime-hours, not registered users or logged-in users, to compare against a dedicated VM. If workloads later occupy capacity continuously, compare a separate worker pool's full operating cost against measured sandbox charges. Keep the hosted plugin using Sandboxes in either case; provider placement remains that service's concern.

**Release gates and exclusions.** No core plugin dependency on hosted-agent; no second Cloudflare bridge; no same-VM public execution fallback; no default prewarming for every logged-in user; no automatic retry of ambiguous side effects; no cross-project runtime reuse; no generic harness adapter registry; no full Runner rewrite. Start with private conversations, one model configuration, a pinned Pi release and one sandbox offer. Multi-provider model UI, shared chat, sub-agent UX, warm pools and pre-baked image optimization are later work.

**Sources and verification scope.** Repository references above were read locally; no production environment was queried. External documentation was checked for this proposal. Cloudflare generic SDK defaults must not override the behavior of our existing provider/bridge. Relevant sources: [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [Pi security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md), [Cloudflare lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/), [limits](https://developers.cloudflare.com/containers/platform/limits/), and [pricing](https://developers.cloudflare.com/containers/platform/pricing/). The provider checkout's `docs/providers/cloudflare.md` and guarded rollout instructions are the authoritative integration-specific starting point.
