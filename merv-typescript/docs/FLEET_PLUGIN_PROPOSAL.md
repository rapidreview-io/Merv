# Optional Fleet plugin — detailed design

Status: proposed. Read with [the joint implementation sequence](FLEET_PI_PROPOSAL.md) and [Pi integration](PI_AGENT_PROPOSAL.md). All named new methods/types below are proposed contracts, not claims that they exist today.

**Purpose.** Fleet turns authorized demand for agent execution into an owned sandbox runtime. It owns compute inventory, admission, provisioning, lifecycle and cleanup. It never defines task readiness, selects workflow assignments, runs Git merges, or stores conversation content.

**Dependency graph.**

| Entry | Hard dependencies | Responsibility |
|---|---|---|
| `@merv/fleet` | State, Scope, Sandboxes | Requests, allocations, caps, reconciliation, workload-owner registrations |
| `@merv/fleet/api` | Fleet, API | Human controls and runtime enrollment/control transport |
| `@merv/fleet/ui` | Fleet, UI | Inventory and admission status |
| `@merv/fleet/workflows` | Fleet, Sessions | Workflow demand projection and managed-runner binding |
| `@merv/pi-agent` | Fleet, State, Scope, Sessions | Conversation owner; see separate design |

Fleet core does not hard-depend on Sessions, Workflows, Code or Pi. The workflows adapter adds that integration only when installed. Shared principal/admission types go in the existing neutral contracts package; Sessions must not import Fleet implementation. Registering/unregistering a validator never changes managed grants into ordinary grants. Missing authority providers fail closed.

Fleet is configured as optional in the application loader, as are its adapters. Deployment configurations may omit the package entirely. A deployment that includes Fleet but has unavailable Sandboxes may serve retained Fleet observations if the service provider remains present/degraded; new allocation is unavailable. If the provider is removed, Cordis may suspend dependents. This lifecycle distinction must be reflected in tests and UI.

**Terminology and ownership.**

- A request is a durable desire for compute, bound to a project, authorizing source, owner, runtime profile and deadline.
- An allocation reserves capacity and identifies one sandbox/runtime generation. It is not an execution credential or workflow lease.
- A runtime is the fixed deployed program in that sandbox: a one-assignment Runner or a Pi conversation worker.
- A workflow execution remains the existing Sessions record. A chat turn remains a Pi record. Their IDs cannot be substituted for one another.
- A profile is operator-configured runtime artifact, allowed sandbox offer, resource/capability declaration and limits. Model text cannot supply executable paths, scripts, image URLs or credentials.

One allocation is one sandbox and one slot initially. Workflow machines are not pooled across assignments in v1. A conversation may keep its own allocation warm across turns. No cross-user/project reuse or simultaneous chat/assignment processes in one sandbox.

**Core service contract.** Keep the contract about capacity and runtime lifecycle, not harness interchangeability.

```ts
interface FleetRequest {
  requestKey: string;                 // scoped to owner + project, immutable fingerprint
  projectId: string;
  authorityRef: string;               // server-issued source delegation, never a bearer
  owner: { kind: string; id: string; revision: number };
  profileId: string;
  admissionClass: 'interactive' | 'workflow';
  expiresAt: string;
}

interface Fleet {
  request(tx: Transaction, request: FleetRequest): Promise<RequestReceipt>;
  cancelRequest(tx: Transaction, requestId: string, expectedRevision: number): Promise<void>;
  inspect(caller: Caller, allocationId: string): Promise<AllocationView>;
  drain(caller: Caller, target: FleetTarget): Promise<void>;
  halt(caller: Caller, target: FleetTarget, reason: string): Promise<void>;
  registerOwner(kind: string, owner: FleetOwner): () => void;
}
```

Request and cancellation accept the current State transaction so Pi can commit a command and its capacity intent atomically. Callers cannot supply an arbitrary authorityRef: ownership, source/project binding, approved profile and caps are validated by Fleet. The owner registration is trusted in-process code, not a script/plugin URL from users.

`FleetOwner` provides bounded metadata-only validation of a request and a retention/settlement receipt. It does not claim workflow tasks or execute network IO within Fleet's transaction. An owner that disappears freezes new demand; active work follows bounded drain and lease expiry. Completion notifications use a durable event/outbox or owner polling, not an in-memory callback as the only record.

Owner reference examples: a Pi conversation generation, or a workflow capacity ticket issued by the workflow adapter. Fleet treats both as opaque. It may retain safe labels and links for UI; no prompts, tool results, checkpoint bytes or raw credentials.

**Records.** Reuse State and its migration/transaction conventions, supporting SQLite and PostgreSQL.

| Record | Fields and invariants |
|---|---|
| `fleet_requests` | Owner key/revision, source reference, class/profile, deadline, revision/state; unique idempotency key and immutable input hash |
| `fleet_allocations` | Request, epoch, project/profile, provision operation key, sandbox/job IDs, reported runner ID, state/deadlines, occupancy, retirement intent |
| `fleet_operations` | Durable next side effect, operation key, attempt/backoff and acknowledged result; retained replay identity |
| `fleet_runtime_events` | Allocation/epoch/sequence, sanitized lifecycle evidence, command acknowledgments, stop/release facts |
| `fleet_controls` | Project/global configured caps, pause/drain state, fair-admission counters/revisions |
| Source grants | Owned by the existing authority service; Fleet stores references/digests, not reusable plaintext keys |

Atomic admission locks a small global/project capacity row in a consistent order and counts all occupied allocations. Do not use an unlocked `COUNT` followed by insertion. Enforce the same rule in PostgreSQL, not only SQLite's single-writer behavior. Provider calls occur after commit. Duplicate requests return the same receipt; changed-input reuse is a conflict.

**Demand from workflows.** Add a compact Sessions service read for automatic capacity demand. It must reuse dispatch predicates rather than copying workflow rules into Fleet. Return source-authorized, unleased, automatically executable demand grouped by compatible profile/capability, plus refusal reasons and a snapshot revision. Exclude operator gates, dependency blockers, holds, retry backoff and inadmissible budgets. Check actual profile/capability suitability; a task requiring Code must not trigger a workspace-free machine.

Do not scrape `projectStatus.queue`, which is a presentation read with a display cap. Do not lease work just to count it. A demand snapshot is advisory and does not reserve a task while a VM boots. The actual lease always revalidates readiness and source authority.

Evaluate demand against the prospective profile's capabilities, not live runner presence or settings acknowledgments: the machine does not exist yet. Reuse dispatch candidate/admission helpers and retain runner-specific checks at actual lease time. Store a revocable source reference, not a serialized Caller treated as permanently authoritative. Deduplicate candidate identity/revision before matching compatible slots. Occasional empty machines after demand changes are an accepted cost of preserving the existing pull scheduler.

V1 has one explicit workflow Fleet enrollment/authorizing source per project. Its configured profiles declare compatible harness/workspace capabilities. This avoids counting the same task once per overlapping user grant. More source scopes require candidate-identity deduplication and matching, not summed queue lengths.

The workflow adapter creates/retracts capacity tickets for unmet demand. Subtract compatible unoccupied capacity already registered, and capacity tickets already provisioning but not represented in runner presence. Match each free slot at most once across capability groups. External free capacity is advisory: allow a short bounded grace for it to claim, then provision if demand persists rather than waiting forever on a healthy-but-refusing external runner. A ready Fleet runner whose demand vanished exits without claiming and is released.

Pending Fleet machines must not be counted twice when they become registered runners. Correlate runner presence to allocation ID/epoch. Existing external runners remain independently operated; Fleet observes their useful spare capacity but never stops them or counts their machines as Fleet-owned resources. Fleet caps therefore mean Fleet-managed compute, not all project execution worldwide.

**Workflow claim path.** Preserve `SessionDispatch.leaseOnce()` and its idempotency, source checks, desired settings, dispatch controls, budgets, backoff, holds, workspace eligibility and transactional reservation. Do not schedule by calling explicit `offer()` or `assignAgent()`; those are deliberate manual paths with different admission semantics.

Add a narrow managed-runner admission guard to the existing automatic lease transaction. The guard verifies allocation/project/epoch/profile and binds the successful execution to that allocation in the same State transaction. V1 permits at most one successful assignment lease per allocation, replayable under the original request identity. Empty lease polls do not consume that allowance. Concurrent attempts cannot bind different tasks to the same slot. No general claim-next framework or task sorting moves into Fleet.

The guard also checks current request cancellation and allocation admission/retirement intent inside that transaction. A still-running machine cannot claim after drain/cancellation wins admission. Test cancellation against concurrent lease creation, with both transaction orderings.

The worker presents a new restricted managed-runner principal, not an ordinary project machine key. Scope authenticates its provenance; the guard enforces the allocation. Permit only exact-runner presence, automatic leasing, exact owned execution control, and the necessary Code transfer/capture endpoints. Deny manual offer, arbitrary agent registration, project administration, unrelated executions and arbitrary tool calls. After binding, constrain all controls to that execution; after closure permit only bounded finalization. Source revocation still invalidates new operations; narrowly defined immutable final receipts must not reactivate authority.

This principal needs intentional API/Scope/Sessions/Code integration. Current ordinary source credentials cannot simply be renamed to claim this restriction. Its validator remains required even if the workflows adapter is unloaded; loss of the registered provider denies managed calls. Existing external credentials follow unchanged paths.

The binding survives assignment completion and lease expiry. Retrying the original request can return its historical receipt, subject to current authentication; a different request cannot obtain a successor assignment. Check revocation before the current lease receipt fast path as well as before new admission. A fresh assignment requires a fresh allocation/epoch. Keep this principal in the trusted supervisor, separated by OS identity/private files from the harness; the agent receives only its assignment authority.

**Shared capacity and fairness.** Interactive requests and workflow tickets use the same allocator. Count admitted/reserved capacity before any provider call, then provisioning, bootstrapping, running, idle-warm, draining, releasing and uncertain states. A process that stopped but still has unacknowledged capture consumes its slot. Failed provisioning consumes a slot until the provider confirms no machine exists or deletion is complete.

Use FIFO within each source/user and weighted round-robin between interactive and workflow classes, with aging and a bounded interactive streak (initial configurable example: at most three interactive admissions while workflow demand waits). Apply user, project, profile and global caps atomically. This is admission fairness, not a promise of equal CPU time. No preemption of running assignments. Reclaim checkpointed idle chat before creating a capacity shortage; profile changes never mutate existing allocations.

Distinguish Fleet pause (no new compute), project workflow dispatch pause (no new automatic assignments), Pi admission pause (no new chat turns), drain (finish and retire), and halt (cancel). Pausing workflow dispatch must not disable an ordinary human chat. Source revocation affects all work relying on that source regardless of switches.

**Sandbox integration.** Add `Sandboxes.runtimes` as a narrow server-owned capability beside `checks`. Suggested internal operations: prepare a runtime artifact, acquire by operation key, start a fixed launch by job key, inspect, renew with expected revision, cancel job, release and confirm absence. Profiles determine commands/artifacts/offers. Reuse `SandboxClient`, project namespace proof, consumer grants, route/redirect restrictions and bounded responses.

The remote service already has idempotent sandbox creation, detached jobs, revision-checked renewals and deletion. It also has compound create/job/capture/release workflows, but Fleet should initially use explicit durable steps so it can distinguish worker readiness from job startup and await Merv retention receipts. A compound workflow may replace steps only if it preserves those exact guarantees.

Our Cloudflare provider requires tunnel access and has a fixed shape per bridge deployment. It keeps the container resident deliberately; Fleet explicitly releases idle allocations. No Cloudflare API keys, Workers SDK, new bridge Worker or provider-specific autoscaler belongs in Fleet. Stage a pinned archive initially instead of updating the shared Cloudflare image on every agent release. Existing image rollout has a broad drain requirement and must remain an operator-controlled infrastructure change.

**Protected bootstrap is a required service extension.** Job `env` is retained in `request_json`, and public jobs accept command text. Neither is a secret transport. The service's internal `script_ref` pattern currently resolves pipeline/snapshot scripts; it is not yet a general protected runtime-launch facility.

Extend Sandboxes with an authenticated runtime-launch operation that stores a short-lived bootstrap envelope encrypted at rest, associates it with one namespace/sandbox/job/launch intent, and resolves it only at job launch into a private file over the existing authenticated tunnel. The normal job record retains a harmless fixed command and opaque reference. Exclude secret files from logs, snapshots, outputs and diagnostics; expire/delete them after exchange or launch failure. Reject arbitrary secret-reference access. An equivalent tested protected-file path is acceptable; ordinary env/command fields are not.

Bootstrap exchanges for allocation/epoch-bound worker-channel credentials and the constrained authority needed by that runtime. No ordinary source key, project sandbox consumer grant, database key or cloud-provider token reaches Pi. A one-time exchange must support lost-response recovery: bind the exchange to a worker-generated public key/request identity, return a replayable encrypted response for that key, and never mint a second enrollment on retry. Rate-limit and expire enrollment. A secret delivered to one sandbox authorizes only its allocation, not another user's conversation or a fresh machine.

**Runtime transport.** Workers connect outbound over HTTPS and pull exact pending commands; push/long-poll reduces latency but durable state remains authoritative. Enrollment reports the expected artifact digest/protocol version as observed metadata, not trusted remote attestation. The fixed launcher verifies archive hashes before execution. Runtime status is untrusted observation; reconcile with job/provider state and server-side authority.

Fleet worker controls cover ready, heartbeat, drain, halt, retention receipt and stopped. Pi's message payloads use Pi-owned endpoints. Runner continues to use existing Sessions/Code APIs with the restricted principal. Neither browser needs a sandbox endpoint. Bound output/event sizes, polling, concurrency and retries.

**State machine and deadlines.**

```text
requested → admitted → provisioning → bootstrapping → ready → running
                                                        ↘ idle
running/idle → draining → retaining → stopping → releasing → released
any nonterminal state → uncertain → reconcile → known state or operator_required
```

Keep desired state separate from observed state. `halt requested`, `process stopped`, `data retained` and `machine released` are different facts. Lost heartbeats are not proof of death. Use finite renewable sandbox leases plus shorter worker authority leases and explicit run deadlines. Renewal must never shorten another valid lease: use existing expected-revision semantics and recalculate on conflict.

Effective worker execution deadline is bounded by source authorization, runtime policy, task/turn deadline and sandbox expiry minus a retention margin. A worker independently stops starting model/tool operations when its last confirmed authority expires. Controller outage may lose uncommitted work at eventual lease expiry; the system reports interruption and reconciles, not guaranteed completion.

For normal release, stop admission, wait for child/tool quiescence, receive authoritative domain retention acknowledgments, stop the runtime, and confirm sandbox deletion. For a lost VM, revoke/fence its credentials and Code writer before replacement; preserve uncertain operations and captures for reconciliation. Fencing prevents new Merv effects but does not undo a remote job already launched.

Track authority fencing, confirmed process termination and released mutable workspace ownership separately. A local lease deadline passing is not evidence of provider termination. Do not transfer mutable workspace ownership to a successor until the required ownership/termination facts are established; isolated replacement copies still require reconciliation of external side effects. Uncertain physical resources continue to consume capacity.

**Drain is new work.** Current `Runner.stop()` terminates owned processes; it is not a drain API. Add an explicit managed one-assignment mode: register, claim once, stop further admission, finish worker and Code operations, publish finalization receipt, then exit. For an allocation retired before claiming, close its admission first and prove no offered lease exists before exit. A future multi-assignment mode would need a stable drain generation acknowledged locally and checked centrally.

**Failure behavior.**

| Failure | Required result |
|---|---|
| Create/start response lost | Reuse operation/job key; recover existing resource; do not allocate another |
| Merv crashes | Durable intents and handles recover before admission resumes |
| Runtime stops reporting | Revoke future authority at deadline; retain uncertainty/capacity until provider/ownership reconciliation |
| Sandbox expires before capture | Mark interrupted/recovery-required; never fabricate a retained commit/checkpoint |
| New prompt arrives during release | Old runtime binding is either still valid or irrevocably retired; new request gets next epoch |
| Membership/source revoked | Deny new tools/leases, request halt, retain bounded cleanup ability without new work |
| Fleet plugin unloaded | New managed admission fails closed; attempt bounded halt/retention; remote finite leases bound orphan lifetime |
| Pi plugin removed | Pi demand withdrawn, its runtimes stopped under retention policy; workflow Fleet remains usable |
| External runner claims queued task while provisioning | Fleet runner sees no eligible work and exits; no task pinning/forced duplicate claim |
| Provider outage | Existing facts readable; backoff/circuit-breaker; no unbounded pending capacity or retry storm |

Plugin unload cannot wait indefinitely. Persist stop/cleanup intents, revoke managed execution authority, make bounded attempts, then rely on independent deadlines/finite provider leases. Retain unresolved records for reconciliation after re-enable. Operator hard-delete may sacrifice uncaptured work; that consequence must be explicit.

**Observability and API.** Proposed operator routes: `GET /fleet/status`, `GET /fleet/allocations/:id`, versioned `PUT /fleet/projects/:id/policy`, `POST /fleet/drain`, `POST /fleet/allocations/:id/halt`. Use current project/admin permission patterns and request IDs for writes. Worker routes are a separate authenticated family bound to one allocation, never operator routes. UI shows class, owner link, profile, sandbox, runner/execution link, lifecycle, last confirmed deadline, queue/refusal reason and pending retention. Machine IDs remain available in Details.

Report CPU/memory profile estimates, allocated wall-time, observed sandbox charges and model usage separately. Existing Sessions budgets remain workflow admission controls; Fleet adds machine limits and conservative compute reservations. Do not label the sum as exact provider billing. Missing data is unknown. A common project spending limit, if introduced, must include in-flight reservations across both channels and avoid counting a workflow execution plus its allocation twice.

**Tests and rollout.** Verify dual-backend capacity races; duplicate request/create/job/enrollment replies; old epoch events; missing authority provider; source revocation inside native writes and remote dispatch; drain/claim race; long capture after worker exit; plugin disable; source overlap/demand deduplication; compatibility matching; external-runner refusal; fair admission; and bounded orphan cleanup. Real acceptance uses three independent code.v2 tasks on three sandboxes with a dependent integration step and one injected failure. Keep provider costs and startup measurements with the acceptance report. Rollback disables new Fleet admissions and drains managed machines; it does not restore old database contents or remove retained Code facts.
