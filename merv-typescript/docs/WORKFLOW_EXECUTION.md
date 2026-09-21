# Fixed workflow execution policies

Workflows owns the fixed policy for each assignable state. Tasks declares its
producer and reviewer policies beside the existing assignment rules. This adds
no plugin, dependency or public tool.

This foundation supplies an internal admission check and stable assignment
metadata. **Ordinary human, actor and user-key requests retain their existing
authority.** A policy hash or registration ID is not a credential. Real session
bearers, policy-filtered public catalogs and transaction-level session guards are
now implemented by [Sessions](SESSION_LEASES.md), which consumes this foundation.

## Four separate responsibilities

| Responsibility     | Owner                                                        | Question answered                                                                     |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Guidance           | Workflows, using domain action rules                         | What is ready, blocked or recommended now?                                            |
| Execution policy   | Workflows, using a fixed declaration from the domain program | Which tools and argument constraints does this state declare?                         |
| Assignment context | Domain recipe and Context Builder                            | What should the agent know to do the work?                                            |
| Session authority  | Sessions                                                     | Which authenticated agent currently holds a bounded right to execute this assignment? |

For example, a producer needs `artifact.create` before there is evidence to
submit. The declared `task.submit_delivery` permission also exists before all
delivery fields are ready. The delivery command still checks the evidence and
revision when called. Changing guidance does not change the declared permission.

## Declarations and binding facts

An assignment rule may supply `execution` and a synchronous `references`
resolver. The declaration contains a Boolean `readOnly` and exact tool names.
Each tool has one or more complete argument-binding alternatives. All bindings
within one alternative must match; values from different alternatives are never
combined.

Bindings can require a literal JSON value, the target instance/project/revision,
an exact named reference, one member of a named reference list, or a subset of
that list. Exact missing top-level values can be inserted. Supplied conflicts
are rejected without string coercion or shallow object merging. Tool schemas
and domain commands remain responsible for other input validation.

An omitted subset field becomes an empty array; choosing a member of a list
requires an explicit value. If multiple alternatives would insert different
values, the caller must disambiguate. Rules are normalized with locale-independent
ordering and hashed with an explicit format version. Literal objects are compared
as complete values, including their nested fields.

`readOnly` describes the assigned work; it is not a blanket prohibition on
explicit protocol writes. A reviewer can be granted `review.start`,
`review.submit`, saved context and checkpoints while the review work remains
read-only. There is no implicit grant from a tool's MCP `readOnlyHint`.

Task binding facts come from the current task, review and pinned input records.
Checkpoint attachments and documents mentioned in a rendered prompt cannot
expand artifact-read authority. References can change as domain facts change,
such as a review acquiring a claim; the declaration and its hash remain stable.
An artifact ID names immutable content in the current Artifacts contract.

These direct-read rules are not a classification of every byte in composite
responses. Assignment/context can include historical checkpoint material supplied
by ordinary authorized callers. A bounded checkpoint call must not attach an
unrelated artifact to obtain its contents through a later context response.
Sessions gives each lease its own credentialless worker actor. Artifacts authored
by that worker therefore belong to exactly that lease. It freezes authorized
checkpoint inputs at offer and admits later outputs only from that same worker;
ordinary deliveries retain actor attribution. See [bounded context](SESSION_LEASES.md).

## Internal checks

`Workflows.execution(caller, { instanceId, expectedRevision }, tx?)` returns the
fixed declaration, its hash, the current registration ID, resolved references
and assignment attribution. It rechecks Scope, revision and assignment
admission. It does not build context or fetch document bytes.

Metadata-only behavior is a contract of trusted program code, verified for Tasks.
Cordis plugins execute in the same process; this is not a sandbox preventing a
misbehaving plugin from accessing another service or its captured transaction.

`Workflows.authorizeDispatch(caller, { instanceId, expectedRevision, policyHash,
registrationId, tool, input }, tx?)` repeats those checks and applies the argument
constraints. Its result is validated input for the proposed tool. It does not
invoke that tool, start work, reserve ownership, or authenticate the supplied
caller. The service consumes a trusted, already authenticated caller just as
the existing domain services do.

Passing the current transaction lets the session guard validate metadata
in the same transaction as a native write. Approval outside that transaction
does not confer a right to commit later. Each check resolves current facts;
the returned metadata is not a transferable or durable capability.

## Persistence and Cordis lifecycle

Registration pins finite, canonical JSON for every nonterminal state, including
explicit absence of an execution policy. A changed declaration, removed grant
or newly added policy under the same already-pinned workflow version is refused.
Use a new workflow version to change authority. The first registration after
the new migration pins declarations for existing stored versions.

The hash pins the declarative policy. It does not fingerprint trusted callback
implementations or tool-handler code. Domain program releases remain responsible
for versioning changes to those semantics.

The installed registration also has a fresh opaque generation ID. Withdrawal
refuses new checks immediately. Reinstalling an identical policy preserves its
durable hash but creates a different generation; an old check request fails.
Application restart also creates a new generation. An absent declaration, an
installed empty allowlist and an unavailable program have distinct meanings.

HTTP `GET /tools` and MCP `tools/list` now obtain descriptions from
`Tools.describe(caller)`. Native project-selection metadata and remote schema
extensions use this common path. This prepares a single place for subsequent
session-specific discovery without adding a session policy to ordinary callers.
Native parsing retains the schema captured at registration, so replacing a
definition's schema through trusted inspection cannot make descriptions and
validation disagree. Schema changes use a new registration.

## Session integration

The [Sessions implementation](SESSION_LEASES.md) binds an actual secret to its principal, source credential and
membership, instance revision, policy and pinned reference facts. The service
must recheck those facts during authentication and native writes, and after
asynchronous mounted connections finish opening. A policy lookup cannot replace
those checks. Public discovery and dispatch must use the same session policy.

Review-claim acquisition and succession now have explicit session ownership.
A new credential must not revive a predecessor's claim, and a source-key
rotation must not silently transfer a lease. Heartbeat and expiry recovery are implemented. Runner processes, workspace
provisioning and durable process reconciliation remain subsequent work.

See the [ordered identity/session plan](IDENTITY_SESSION_PARITY_PLAN.md) and
[assignment contract](WORKFLOW_ASSIGNMENT_PLAN.md).

## Workspace intent and automatic discovery

Fixed policies may additionally declare `workspace` as `none`, `ephemeral` or
`persistent`, with safe namespaces and explicit central/reference bases.
`effectiveWorkspace()` supplies scratch intent for absent declarations without
changing their stored hashes. Read-only policies cannot advance central.
`dispatchCandidates()` reads program admission and dependency/recipe metadata
without rendering packets or resolving reference values. It leaves out an instance
whose [loop limit](BUDGETS_AND_LIMITS.md) is exhausted: a reviewer leased for it could only
have a returning verdict refused and rolled back, and the next poll would lease another.
A person can still begin that work by hand. Actual base resolution
and Git provisioning remain machine-runner work. See the [runner control plane](RUNNER_CONTROL_PLANE.md).
