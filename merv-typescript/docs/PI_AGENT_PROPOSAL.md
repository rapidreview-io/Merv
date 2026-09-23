# Optional Pi agent package — detailed design

Status: proposed, not implemented. Read with [the implementation phases](FLEET_PI_PROPOSAL.md) and [Fleet contracts](FLEET_PLUGIN_PROPOSAL.md).

**Product boundary.** Installing Pi adds an Agent row to the sidebar. Opening it creates or resumes a conversation. Sending a message requests an agent runtime through Fleet. Neither action creates a workflow task. When the conversation actually needs tracked execution, it uses existing authorized workflow tools to create a real task; that task follows ordinary readiness, review and Runner claiming rules.

Pi hard-depends on Fleet. External Codex/Claude connections do not depend on either package. Fleet remains useful without Pi, supplying machines for existing Runner profiles. Keep the Merv control plane on its main VM; run Pi and assignment harnesses in separate Sandboxes-managed runtimes. Initial deployment uses the existing Cloudflare provider through that service.

**Use one concrete harness.** Integrate the Pi SDK, currently published as `@earendil-works/pi-coding-agent`, from the [official repository](https://github.com/earendil-works/pi). Pin an exact version and lockfile in the worker artifact. Use its [SDK integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), session manager and event stream. Do not build a harness-neutral conversation abstraction or launch the interactive terminal UI behind a web terminal. Pi's [documented security boundary](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) does not replace OS isolation, Merv authorization or approval policy.

The package has four entry points, with separate bundles:

| Entry | Responsibility |
|---|---|
| `@merv/pi-agent` | Durable conversations, commands, approval records, runtime bindings and checkpoint pointers |
| `@merv/pi-agent/api` | Browser endpoints, authenticated runtime command/events and bounded model relay |
| `@merv/pi-agent/ui` | Agent sidebar row, conversation views, reconnect and approval cards |
| `@merv/pi-agent/worker` | Pinned Pi SDK, explicit tool bridge, local session storage and checkpoint exporter |

Only the worker imports Pi. Its dependency tree and model execution stay out of the main server process. Server dependencies are Fleet, State, Scope and Sessions for existing agent attribution/authority integration; a conversation is not an existing workflow Session. API/UI entries follow current registration conventions. The current web app has a compiled view registry, so adding the first Agent view needs a small web entry registration; adding a sidebar row alone cannot dynamically load an arbitrary renderer. Packaging must test that the base application builds when Pi is absent.

**Conversation records.**

| Record | Purpose |
|---|---|
| `pi_conversations` | Project, owner, stable agent identity, title, revision, status, desired runtime generation and checkpoint pointer |
| `pi_messages` | Canonical user/assistant messages and durable tool outcomes, with server ordering |
| `pi_commands` | Idempotent prompt/steer/follow-up/cancel intents, payload digest, revision and delivery/application state |
| `pi_runtime_bindings` | Conversation generation → one Fleet allocation/epoch, authenticated worker identity and acknowledged command cursor |
| `pi_events` | Bounded durable control/outcome events and browser replay cursor; token deltas may have shorter retention |
| `pi_approvals` | Exact pending operation/argument digest, source revision, command, epoch, decision and expiry |
| `pi_checkpoints` | Immutable artifact digest, compatibility metadata, active session leaf and committed command watermark |
| `pi_tool_operations` | Durable mutation intent, domain request ID, admitted/completed/uncertain outcome and reconciliation reference |

Use the existing State transaction and artifact facilities where appropriate; do not introduce a message broker or vector database. A unique constraint/CAS prevents two active runtime bindings for the same conversation generation. Every read/write checks the current conversation owner/project permissions. Sharing conversations can be a later explicit feature.

**Message-to-runtime path.**

1. Browser sends a command with a client-generated idempotency key and expected conversation revision.
2. In one State transaction, Pi validates current authority, records the user message and command, and either uses the valid current binding or requests Fleet capacity for the next runtime generation. Same-key different-payload reuse is a conflict.
3. Fleet admits and launches the configured worker. Pi attaches it with a generation CAS. Duplicate ready notifications cannot attach a second worker; cancellation during provisioning leaves a durable retirement intent.
4. The worker authenticates its exact conversation/allocation/epoch, restores the compatible committed checkpoint and pulls commands. It subscribes to Pi events before starting a prompt.
5. The worker acknowledges command receipt and application separately, then reports bounded events and tool outcomes. Only the current generation can append canonical outcomes or advance the checkpoint pointer.
6. On settled completion, the worker uploads/verifies the session checkpoint and Pi commits the pointer. The conversation becomes available for its next queued prompt or remains idle until its retention/eviction deadline.

There is one active turn per conversation initially. Additional ordinary prompts queue. Expose Pi's steer and follow-up behavior deliberately: steering is applied at a supported boundary after current response/tool work, not an immediate interruption. Cancel is a separate control command. Use Pi's settled continuation boundary rather than treating every `agent_end` event as durable completion; pin and test those event semantics against the selected release.

Commands have IDs, conversation ID, epoch, expected revision, type, payload and deadline. Worker event sequence is scoped to its epoch; the server's conversation cursor is separate and monotonic across restarts. Duplicate transport delivery is normal. Accepted, delivered, applied and completed are separate states. Persisted commands do not imply exactly-once model execution.

**Tools and authority.** Pi does not supply the Merv MCP authorization boundary. Build a small bridge from the existing Merv tool catalog/invocation path to Pi custom tools. Preserve names, JSON schemas, descriptions, structured results, errors and cancellation. Convert outcomes into Pi's expected content/details representation and real tool failures; never turn an error string into apparent success. Reuse source grants and tool-policy checks rather than implementing a second policy engine.

Chat gets a bounded conversation grant, separate from workflow assignment authority. It records the initiating source, project, stable agent identity, allowed tool policy and runtime epoch. Revalidate source membership/revocation on every invocation. The current idle-agent token must not be assumed to provide this new grant automatically; implement and test an explicit authority provider. Do not encode a conversation ID as `Session.instanceId`, weaken nested-delegation restrictions, or use a credential-free service actor as the authority behind user actions.

Its explicit contract also includes `expiresAt`, source membership/credential revision and tool argument constraints. Check expiry and current authority at tool discovery and dispatch, including native transactional writes. Expiry is bounded by source validity, the turn deadline and the runtime authority lease. An idle conversation stores history, not an indefinitely valid execution grant.

The initial chat worker has only the selected Merv tools and model access: no general shell, filesystem tools, arbitrary extension loading or user-supplied runtime commands. Code execution and repository mutation run in ordinary workflow assignment workers with frozen session authority and Code writer fencing. Later research tools may explicitly launch their own authorized sandbox jobs, with ownership recorded; those are not invisible children of the conversation VM.

Instantiate Pi with explicit settings, resource loader, tool set, private working directory and model configuration. Disable ambient credential/resource/plugin discovery and loading repository-provided extensions. Do not import arbitrary workspace agent instructions into the coordinator by accident. Any intentional project instructions remain untrusted content under the server's policy.

Use stable producer identity and existing review lineage checks. Starting another conversation or VM must not launder the producer into an independent reviewer. Genuine review runs have the existing independent reviewer role/context and authority, without secretly inheriting a producer's private session tree.

**Model access and secrets.** Use a small server-side model relay for the first supported provider/API shape. The worker receives a short-lived allocation/epoch-bound gateway credential, never the provider's long-lived key. Allowlist configured models; enforce request/output sizes, per-turn limits, concurrency and project budgets, and record usage without prompt logging by default. This is an authenticated bounded relay, not a general URL proxy or model marketplace. Validate Pi streaming/tool-call/abort compatibility in phase 0 before committing to a provider transport.

Keep three grants distinct: worker control channel, model relay and domain tools. Revoking the runtime fences all three. Bootstrap uses Fleet's protected Sandboxes runtime-launch extension; ordinary job command/env fields persist and must not carry secrets. A same-OS-user process can read its own credentials: protected delivery prevents control-plane leakage, not that threat. Chat's lack of shell reduces exposure. In an assignment sandbox, the trusted Runner supervisor retains the managed-runner credential and gives the agent only its assignment authority; use distinct OS users/private files, a scrubbed environment and restricted IPC. Verify the provider image supports this separation before claiming it. The VM remains the tenant isolation boundary.

**Approvals and cancellation.** Use current operation policy to decide which tools need approval. Persist a concrete operation and argument digest with source revision, command, epoch and expiry. An approval permits that exact operation within existing privileges. It does not broaden the grant. Decisions are authenticated/idempotent; stale decisions cannot approve a changed request or a new runtime invocation. On restore, reconnect to the same pending operation if possible, otherwise invalidate and present a fresh concrete request.

Stop first fences admission of new model/tool calls, invalidates pending approval admission, and asks Pi to abort. Escalate to job cancellation and sandbox release after bounded grace. A previously admitted remote operation may finish; cancellation is not rollback. Independently launched research jobs follow their own explicit cancel/retain policy and remain visible. UI distinguishes “Stopping”, “Stopped” and “Machine shutdown unconfirmed”.

**Persistence and recovery.** Pi's session manager stores a structured session tree, including compaction and branch state. Preserve that canonical representation and active leaf rather than reconstructing context from visible chat messages. The checkpoint envelope contains format version, Pi/worker release, conversation ID, epoch, command high-watermark, active leaf, tool-catalog/model-configuration revisions and workspace receipt references. Upload an immutable blob, verify its digest, then commit the pointer with a revision check. Retain the previous committed checkpoint until its successor is valid. Unknown versions fail with a visible migration/recovery state rather than opening a blank conversation.

Checkpoints support continuation; they are not a mutation transaction log. Persist tool intents/outcomes separately and reuse domain idempotency IDs. If a mutating call's result is lost, reconcile with the owning domain. If it cannot be resolved, show uncertainty and require an explicit decision rather than retrying blindly. A prompt applied before worker death may have incurred model cost or side effects even if its final acknowledgement is absent.

| Failure window | Recovery |
|---|---|
| Command saved but not delivered | Redeliver same ID |
| Pi applied prompt but reply/ack lost | Consult command ledger; if unresolved, mark interrupted without automatically re-prompting |
| Mutation completed but result lost | Resolve domain operation ID; retain uncertainty if unresolved |
| Final answer saved but checkpoint failed | Show answer with restoration-incomplete status; retry retention |
| Checkpoint uploaded but pointer commit lost | Retry digest/revision commit; later garbage-collect unreferenced blob |
| Runtime dies mid-turn | Restore last compatible checkpoint and reconcile durable operations; expose interrupted work |
| Old runtime returns after replacement | Reject stale epoch writes/grants; retain physical uncertainty until resolved |

A turn is fully completed when its user-visible outcome and continuation checkpoint are durable. The answer may appear earlier with a “Saving” state. Failure to save must not erase a real tool result. Bound token-event buffers and replace them with canonical messages on reconnect. Do not promise recovery of every streamed token or uncaptured filesystem change.

Before normal idle eviction, quiesce tools and commit a checkpoint. Fleet receives a retention receipt and retires the sandbox. A later message restores the same conversation in a new runtime generation. Pending prompts do not create extra simultaneous conversation VMs. A local lease timestamp passing alone is not proof the old process stopped; authority fencing, process termination and mutable workspace ownership are separate facts.

**API and UI.** Proposed browser routes: `POST /pi/conversations`, `GET /pi/conversations/:id`, `POST /pi/conversations/:id/commands`, `GET /pi/conversations/:id/events?after=...`, and `POST /pi/approvals/:id/decision`. Reuse existing authentication and streaming conventions; durable cursor recovery must work after disconnect. Worker endpoints form a separate authenticated family, not browser/admin routes.

The Agent row contains recent conversations and New conversation. Show “Waiting for capacity”, “Starting agent”, “Ready”, “Working”, “Needs approval”, “Saving”, “Paused” and “Recovery needed” in ordinary language. Keep VM IDs, epochs and leases in Details with a Fleet link. Link actual created workflow tasks in the transcript. A project workflow pause does not disable normal conversation allocation. If Pi is absent, omit its row; if installed but Fleet is unavailable, show a useful unavailable state and retain readable conversation history whenever dependencies permit.

**Pi for assignment execution.** After chat works, add a Pi Runner profile using the same pinned worker artifact/tool bridge, but a distinct assignment entry point. It receives ordinary frozen workflow authority and Code workspace configuration; it does not load a chat transcript or mint its own agent identity. Preserve separate producer/reviewer context. Limit v1 to one assignment per sandbox and final capture before release. Existing Codex/Claude/command profiles remain supported and unchanged. Add a narrow profile/platform literal only where current contracts require it; do not refactor every harness behind a new general SDK.

**Validation and rollout.** Use fake Fleet/model workers first to test command/binding races, durable reconnect, cancellation, source revocation, stale epochs and approval invalidation without paid resources. Then prove one real Cloudflare-hosted read-only conversation, idle eviction and restore, a tool mutation with an injected lost response, and a separately executed Pi assignment with Code capture. Test installation matrix: neither package; Fleet only; Fleet+Pi; Pi enabled without Fleet rejected clearly. Verify absent plugins do not register routes/services or load worker dependencies. The default compiled browser may retain an inert Agent renderer; distributions omitting that source package require a small optional build entry. Pi SDK and worker code never enter the browser or base server execution path. Disable new Pi admission for rollback, checkpoint/drain active workers and retain records; external connections and other Fleet owners continue independently.
