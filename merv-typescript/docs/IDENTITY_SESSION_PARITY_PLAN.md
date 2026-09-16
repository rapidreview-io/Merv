# Identity and session parity

Status: the **project-bound credential foundation, shared-user membership and
user-owned project/account keys are integrated locally**. Production shared login
still needs its intended Supabase configuration and real browser verification.
The [fixed workflow policy foundation](WORKFLOW_EXECUTION.md) is integrated:
version-pinned declarations, metadata admission and canonical tool descriptions.
The [Sessions control plane](SESSION_LEASES.md) now implements public enforcement,
durable leases and worker/reviewer ownership recovery. The [runner control plane](RUNNER_CONTROL_PLANE.md) now supplies automatic assignment, project pause/halt, runner presence and the Sessions page. The [machine Runner](MACHINE_RUNNER.md) supplies native execution, crash recovery and [Git workspace preparation/capture](WORKSPACES.md). The independent [Code service](CODE_OPERATIONS.md) queues live-worker commit requests and retains the Runner's immutable receipts; [proposal sealing](CODE_PROPOSALS.md) preserves the original worker and exact evidence. Production research proposal gates and publication remain open. The implemented [assignment and begin](WORKFLOW_ASSIGNMENT_PLAN.md)
slice supplies an assignment preview and a historical first-start marker; neither
one is a lease or an enforced tool allowlist.

This plan records the Python behavior to preserve and the order in which to
integrate it. Verified shared users now have explicit issuer/subject identities;
an ordinary operator actor alone is still not proof of a shared human account.

## Keep four identities distinct

| Identity              | Meaning                                                               | Lifetime and authority                                                                                                  |
| --------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Shared user           | The verified human account, shared with Nisa                          | Stable across projects and credential rotation; project membership grants access.                                       |
| Operational actor     | The person or agent identity attributed to Merv work                  | The current TypeScript actor has a project and role. It is not proof of a shared human account.                         |
| Credential            | The bearer used to authenticate a request                             | Independently identified, scoped, expiring and revocable; changing it need not change the actor or its historical work. |
| Agent context/session | One agent context window, and, for dispatched work, its bounded lease | An agent identity records attribution; a lease separately authorizes a particular assignment.                           |

Python's [Principal][py-principal] separates user, client, key and agent-session
fields. Its [agent identity service][py-agent-identity] gives one context window an
identity, reuses it only for an authorized owner and binds leased callers to their
own session. `parent_agent_id` is trace metadata, not a grant of authority. Key
rotation lineage and reviewer succession are separate relationships; Python does
not supply a general parent/child session delegation tree.

## Integration order

Complete and verify each row before building the next.

| Order | Scope                                                               | Status                                                                | Integration proof                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Separate project-bound credentials from actors                      | Integrated                                                            | Existing tokens still work after migration; expiry, rotation and revocation are enforced through HTTP, MCP, domain transactions and delayed mounted dispatch.                                                      |
| 1a    | Shared identity, project memberships and explicit project selection | Integrated locally                                                    | Signed-user HTTP/MCP and live agents reach project-specific roles; removal in A preserves B; explicit local repair and legacy token isolation are tested. Real configured browser login remains a deployment gate. |
| 1b    | User-owned project/account machine keys                             | Integrated locally                                                    | Owner-bound grants, rotation lineage, current membership, owner cleanup after departure, HTTP/MCP/UI and asynchronous mount guards are integrated. Machine keys cannot mint independent authority.                 |
| 2     | Fixed execution authority declared by workflow nodes                | Integrated with Sessions                                              | Declarations, durable hashes, argument checks and reload fences are implemented without context rendering. Actual session discovery, dispatch and writer guards now consume the same fixed declaration.            |
| 3     | Durable session leases and activation                               | Integrated locally                                                    | Concurrent offers cannot create two live leases for the same revision; first authorized use activates once; retries, expiry, heartbeat, source revocation and revision changes are fenced.                         |
| 4     | Session-aware worker and review recovery                            | Integrated locally                                                    | An authorized successor receives its own ownership handle and useful context; old owners cannot commit after replacement; evidence and history survive.                                                            |
| 5     | Runner processes, workspaces, Code operations and controls          | Processes, Git capture and fixed commits integrated; publication open | Durable launch intent precedes process creation; halt/expiry stop children; live-worker commits and final captures retain separate receipts through lost replies and restart.                                      |

These are capability boundaries, not a requirement to add one plugin per row.
The independent Identity provider verifies JWTs outside transactions. Scope owns
user, membership and access facts; Workflows owns assignment and node policy;
the API applies credential and tool policy; a session service owns leases; domain
plugins own claims and recovery; Context Builder continues using task recipes.
The runner consumes those contracts after they work without a child process.

### 0. Project-bound credential foundation

Separate credential records retain the actor/project association, secret digest,
creation time, expiry, revocation and rotation predecessor. Migration preserves
legacy token hashes and their original authority. Actor IDs, task ownership and
review attribution remain stable through credential rotation.

The [implemented credential lifecycle](ACTOR_CREDENTIALS.md) supports additional
issuance, metadata inspection and staged self-rotation: issue a replacement,
verify it, then revoke the old credential. This avoids lockout if a response is
lost. Self-issued replacements cannot extend a finite deadline. Operator
administration remains separate from future bounded session delegation.

Every authenticated request carries the resolved credential ID through its
`Caller`. Scope rechecks that credential against the same actor/project inside
domain transactions. The registry rechecks immediately before handler dispatch;
Mounts rechecks after asynchronous connection setup before sending upstream.
Trusted in-process configuration and committed domain-event handling may remain
unbound to a request credential. Saved context retains actor/project attribution
without bearer secrets. The later user-key implementation records nonsecret key
and membership IDs on domain events for source-authority audit.

Actor revocation and credential revocation have different meanings. Revoking one
credential must not silently delete the actor or its evidence. A known local
credential, including an expired or revoked one, must not be mistaken for an
upstream bearer by the remote Credentials adapter.

This foundation introduces no shared-user identity, membership table, account
credential, Supabase/OAuth adapter, session token or process launch. Public
credential administration keeps the current TypeScript operator authorization;
that role alone will not become proof of a verified human account in step 1.

### 1. Shared users and memberships

The [implemented shared-user slice](SHARED_IDENTITY.md) supplies verification,
membership roles, project selection, onboarding and local ownership repair.
The [implemented user-key slice](USER_KEYS.md) adds explicit account grants;
existing actor credentials retain their original scope. TypeScript adds explicit
per-project roles and protects the last verified operator, while invitations may
still precede first login.

Python uses a verified Supabase subject as the shared user identity. A
[project membership][py-membership-schema] joins a user to a project; its existing
rows grant full member access and do not encode the TypeScript operational roles.
Preserve the distinction when introducing a membership/role policy here.

Required behavior:

- Create the project and its initial human membership atomically. Membership
  additions are idempotent. Removing an absent member is harmless; removing the
  last member is refused. With role-based administration, additionally preserve
  an administrator who can manage the project.
- Check credential project confinement before checking membership. A project key
  stays in its original project even when its owner belongs to several. An
  explicitly issued account key can reach the owner's current memberships; it
  remains a machine credential and cannot perform human-only administration.
- List reachable projects and require explicit selection where needed. Do not
  invent a home-project fallback for an unscoped request.
- Removing membership in A does not remove the user or access to B. A user can
  still revoke their own account key after leaving the project where it was
  created, while new issuance there still requires membership.
- Rotation preserves owner and grant scope. Python recursively revokes rotation
  descendants; document and test the equivalent rule rather than widening a
  grant during rotation.

The implemented key lifecycle uses human-only atomic rotation and recursive
revocation, including already-rotated ancestors. Account rotation can use another
current membership after leaving its issuance project; its recorded provenance
does not change. Project rotation still requires membership in that project.
Domain events retain source key and membership epoch. Key retirement preserves
actor work; later sessions will bind the specific source key separately.

Sources: [project creation and membership operations][py-research],
[membership persistence][py-store], [project authorization][py-gateway],
[key lifecycle][py-keys], [account-scope regression tests][py-account-tests].

### 2. Fixed authority before sessions

Implemented foundation: see [the execution contract](WORKFLOW_EXECUTION.md).
Task assignments now display fixed manifests; the internal execution/admission
methods check current metadata and registration generations. HTTP/MCP share
canonical registry descriptions. The later [Sessions slice](SESSION_LEASES.md) supplies the actual credential
enforcement for rows 2–3. Ordinary keys retain their normal project authority. A session must additionally pin its authenticated principal, source key,
membership, reference facts and ownership and be rechecked at each use.

A node's execution policy declares its permitted tools, mutating subset, exact
argument bindings, sandbox access and workspace policy. The policy is stable for
the installed workflow version. Current guidance can change as evidence arrives;
`execution.tools` suggestions in today's assignment packet must not be converted
directly into authority by filtering whichever actions are currently ready.

Python's [Execution contract][py-execution] requires mutating tools to be a subset
of declared tools and forbids mutation/sandbox access on a read-only node. The
[surface policy][py-http-policy] adds explicit baseline tools; missing execution
policy defaults to read-only. Read-only reviewers can still receive a specifically
declared review-submission capability. The policy needs a deliberate mapping to
the actual TypeScript tools, including mounted tool names.

Use the same effective allowlist in tool discovery and dispatch. Bind missing
declared top-level arguments from the pinned assignment; reject conflicting
provided values, including nested scope fields. Generic transitions must match
the leased instance and revision. Session principals may inspect their assignment
but do not call interactive `workflow.begin`; session activation owns that start.

Build a dispatch-only admission path first. Repeated authentication must not read
artifact bytes or rebuild the prompt inside a writer transaction. Missing exit
evidence blocks submission, not the work required to produce it. Context remains
assembled at assignment/lease boundaries. Sources: [runtime admission][py-runtime],
[gateway enforcement][py-gateway], [contention tests][py-contention-tests],
[dispatch tests][py-dispatch-tests].

### 3. Durable leases and authenticated activation

Sessions consume opaque workflow/instance/revision/role/reference and policy
facts. They do not need task or experiment-specific branches. Python's
[lease service][py-sessions] and [schema][py-session-schema] establish these laws:

- Store only the high-entropy session secret's digest. Enforce one live
  `offered`/`active` lease per `(project, instance, revision)` and one receipt per
  `(runner, idempotency key)` in the database. Retry with changed secret, project,
  platform or source authority fails; a closed retry returns its old receipt.
- Treat dispatch candidates as hints. Recheck assignability and pin assignment,
  references and policy in the offer transaction. Python bounds each serialized
  packet at 64 KiB.
- Offer/attach does not start work. Authentication checks expiry, target revision,
  current source authority and admission before first activation. It records the
  first activation and renews a live lease within its hard deadline.
- Python defaults are a 5-minute offer, 4-hour active lease and 24-hour hard
  deadline, capped at 7 days. Choose explicit tested configuration if changing
  them. Offered leases cannot be renewed by active heartbeat.
- Attach, heartbeat and release are restricted to the authenticated owning
  runner. Conflicting host/workspace attachments fail. Runner identity and source
  user/key come from authentication, not caller-controlled arguments.
- An expired, released or revoked session cannot regain authority. Missing or
  terminal targets, unavailable workflow authority and changed revisions close
  it. Source-key revocation/expiry and lost project membership are rechecked.
- The session bearer is MCP-only and cannot become a runner-control credential.
  Lease/attach/heartbeat/release are runner HTTP operations, not public
  `session.spawn` or delegation tools.

Disabling project dispatch stops new offers; it does not itself kill existing
sessions. Explicit halt closes them. Disabled dispatch must skip expensive
candidate preparation. Sources: [session HTTP operations][py-session-api],
[surface lifecycle tests][py-session-tests], [gateway][py-gateway].

### 4. Recovery preserves work and replaces authority

Extend the existing actor-revocation recovery with lease-aware domain ownership.
An expired/revoked worker does not authorize an arbitrary new claimant. Admit a
successor against current project, instance, revision, role and pinned reference
facts, and ensure no other live lease owns that assignment.

For a review, preserve the request and pinned evidence, supersede the old handle
and give the successor its own handle. Python's `permits_successor` also requires
matching predecessors to be released or expired. Recheck the live handle/lease
inside the verdict transaction: revocation after HTTP authentication but before
handler execution must still fail. Keep first-start history distinct from current
ownership.

Tasks and Reviews remain responsible for domain recovery records. Context Builder
uses the existing recipe mechanism to include the assignment, evidence,
checkpoints and recovery notes for the next actor. Sources:
[successor validation][py-sessions], [revocation race and succession tests][py-session-tests].

### 5. Runner after the control plane

The [server prerequisites](RUNNER_CONTROL_PLANE.md) are integrated and verified: metadata-only candidates, fixed workspace declarations, source-bound runner presence/capacity, desired settings, default-off automatic leases and project pause/halt. The Sessions page shows these through optional adapters. Process ownership, Git preparation/capture and fixed commit execution are now integrated on those foundations.

The machine Runner polls eligible work, acquires a lease, prepares
a workspace and launches an agent. It persists launch intent before spawning,
qualifies process identity on restart and does not launch a duplicate when a
previous launch is uncertain. Credentials belong in child environment channels,
not prompts, process arguments, workspace files or logs.

Workspace policy distinguishes scratch work, detached ephemeral worktrees and
persistent instance branches. Halt, expiry, release and revision changes
reach the child process. A fixed `code.commit` grant lets a live writable worker
queue a commit through Code; `code.operation` reads its immutable receipt.
The source-authenticated Runner performs the fixed Git operation with durable
replay and checkout-owner fencing. Final stopped-worker capture remains separate.

Production consolidation needs a reflection-owned proposal command using the
existing Code seal contract. General merges and persistent branch publication
still need durable intent and a compare-and-swap receipt, separately from an agent reporting success. Retain
runner liveness, session status, failures and workspace outcomes for the UI.
Cross-machine object transport, pairing, source-key handoff and full telemetry
remain open. A commit receipt does not close these gates or imply publication.
Source: [Python session/runner contract][py-session-design].

## Python verification evidence

On 2026-09-14, the following local Python regression groups passed: **137 tests**.
This verifies the reference behavior; it is not a claim that these features are
implemented or tested in TypeScript.

Run from `merv/` with the existing Python environment:

```sh
PYTHONPATH=src /opt/anaconda3/bin/python -m unittest \
  tests.state.test_agent_sessions tests.surface.test_agent_sessions \
  tests.workflow.test_dispatch tests.workflow.test_auth_contention \
  tests.surface.test_agent_identity tests.surface.test_project_keys

PYTHONPATH=src /opt/anaconda3/bin/python -m unittest \
  tests.surface.test_auth tests.surface.test_account_scoped_keys
```

| Group                                                          | Result                     | Local audit log                                  |
| -------------------------------------------------------------- | -------------------------- | ------------------------------------------------ |
| Sessions, dispatch, admission, agent identity and project keys | 100 passed, 11.207 seconds | `/private/tmp/merv-session-parity-python.log`    |
| Authentication and account-scoped keys                         | 37 passed, 4.085 seconds   | `/private/tmp/merv-membership-parity-python.log` |

The first group deliberately exercises an open-control test composition and
prints its configuration warning. These were local fixture tests, with no live
authentication deployment or runner launch.

[py-principal]: ../../merv/src/merv/brain/surface/identity.py
[py-agent-identity]: ../../merv/src/merv/brain/surface/agent_identity.py
[py-membership-schema]: ../../merv/src/merv/brain/kernel/state/persistence.py
[py-research]: ../../merv/src/merv/brain/research_core/research.py
[py-store]: ../../merv/src/merv/brain/kernel/state/store.py
[py-gateway]: ../../merv/src/merv/brain/surface/transport/api/gateway.py
[py-keys]: ../../merv/src/merv/brain/surface/project_keys.py
[py-account-tests]: ../../merv/tests/surface/test_account_scoped_keys.py
[py-execution]: ../../merv/src/merv/brain/workflows/graph.py
[py-http-policy]: ../../merv/src/merv/brain/surface/transport/http_policy.py
[py-runtime]: ../../merv/src/merv/brain/workflows/runtime.py
[py-contention-tests]: ../../merv/tests/workflow/test_auth_contention.py
[py-dispatch-tests]: ../../merv/tests/workflow/test_dispatch.py
[py-sessions]: ../../merv/src/merv/brain/agent_sessions/agent_sessions.py
[py-session-schema]: ../../merv/src/merv/brain/agent_sessions/persistence.py
[py-session-api]: ../../merv/src/merv/brain/surface/transport/api/agent_sessions.py
[py-session-tests]: ../../merv/tests/surface/test_agent_sessions.py
[py-session-design]: ../../merv/src/merv/brain/agent_sessions/agent_sessions.md
