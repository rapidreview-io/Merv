# Merv TypeScript execution plan

Status: execution started, 2026-09-13. Follow [EXECUTION_LOG.md](EXECUTION_LOG.md) for completed gates and current evidence. The numbered scope and order below remain the acceptance criteria.

The first milestone is a small, observable Cordis application that can connect to an independent service and survive that connection being removed. The second is the same application running on Postgres. Broader identity, hosted storage, research programs, and autonomous execution follow those proofs.

## Working rule

Finish one numbered step before starting the next. Every step includes its contracts, implementation, configuration, existing consumers, focused tests, runnable integration demonstration, and documentation. A component existing in a folder is not completion. The application must actually use it.

Keep each completed step as a separately reviewable commit. Run the boundary checks and affected behavioral tests; run the complete task/evidence/review/feed scenario when a shared contract or lifecycle changes. Re-run live agents at integration milestones that affect their transport or workflow, rather than spending live calls on formatting changes.

For each plugin, verify its smallest useful dependency set. Removing an optional plugin must remove its exposed capabilities, settle admitted calls, and leave unrelated work functioning. Removing a foundational provider is expected to suspend its dependents. Reinstallation must not duplicate registrations or erase durable state. Resource cleanup must also work when initialization fails.

Use server-owned identity and explicit transactions throughout. A remote tool call cannot participate in a local database transaction. Disconnecting a remote service does not imply that its durable jobs or cloud resources have stopped.

## Ordered work

### 1. Establish the baseline

Keep `merv-typescript` as a committed subtree of the existing Merv repository, using its current npm workspaces. This is the default repository decision for this plan; there is no need to introduce a second Git repository now.

Record the existing source, lockfile, docs, boundary checks, and reproducible test scripts. Keep dependencies, caches, credentials, SQLite files, and private live-run transcripts ignored. Choose one formatter and apply it in a separate mechanical change. Declare and verify the supported Node version and installed dependency versions.

**Complete when:** a clean checkout can install from the lockfile, typecheck, run the existing tests, initialize a project, and start the current application using documented commands. No private runtime material is tracked.

**Why first:** all later changes need a reviewable, reproducible starting point.

### 2. Repair lifecycle failures

Fix the two reproduced defects: the workflow adapter must withdraw all of its tools before waiting for any admitted call; failed SQLite initialization must close the acquired database handle. Inspect the other adapters for the same admission pattern. Preserve the correct ordering between service withdrawal, consumer draining, and resource closure.

**Complete when:** a held workflow call can finish, every new workflow call is refused during unload, initialization failure releases resources, and the existing feed removal/reinstallation scenario still passes. Test behavior through the registry and real HTTP/MCP where the failure crosses that boundary.

**Why here:** every new plugin will depend on this teardown behavior.

### 3. Use Cordis configuration and its loader

Verify and pin the upstream loader version compatible with the current Cordis runtime. Load the existing composition from a validated plugin configuration and use loader completion instead of `settle()` polling. Retain explicit checks that required entries are active: finishing initialization is not the same as satisfying every dependency.

Give plugins stable entry IDs and expose current lifecycle status through a small local diagnostic interface. Registration should not require adding a component to the hard-coded bootstrap union. New plugins should own their public service types and Context declarations; consumers may import public contract entry points, while boundary checks continue to prohibit implementation imports. Move existing declarations only as needed for this working extension path.

**Complete when:** the current application starts from config, an additional fixture plugin loads without editing `app.ts`, missing dependencies produce useful errors, and disabling/re-enabling feed through the loader preserves the existing task/review loop. Verify the current fiber after replacement instead of relying on the original handle map.

**Why before more plugins:** new components should use the final installation mechanism from their first integration.

### 4. Make the tool transport ready for external tools

Verify the protocol versions supported by the installed SDK, an actual target agent, and the intended remote service. Record a tested compatibility matrix and explicit unsupported-version behavior. Upgrade or isolate transport adaptation where necessary; do not treat changing a version string as protocol support.

Extend the registry contract to accept validated remote JSON Schemas alongside native Zod-backed definitions. Preserve MCP content blocks, structured results, error status, and relevant annotations instead of wrapping a remote MCP result inside another JSON text result. Reserve a deterministic mount namespace, detect naming collisions, and define how local project selection is separated from remote arguments with the same name.

**Complete when:** the 26 existing tools still work, a separate local MCP fixture can describe and return representative remote results without loss, and incompatible versions and unsupported schemas fail clearly. Pagination and tool-catalog refresh behavior are tested for the supported protocol. Changes to a remote catalog are validated before being exposed.

**Why before mounting a service:** the current registry requires Zod and the transport serializes every success as JSON text. Neither is a transparent remote-tool interface.

### 5. Add the smallest credential and permission boundary

Introduce a narrow credential-provider contract with an initial configuration-backed implementation. Resolve an upstream credential from the authenticated Merv actor/project and the configured mount. Keep secret values on the server; mount config holds secret references. Authenticate the caller at Merv, then use a separate credential accepted by the upstream service.

Implement explicit tool grants for this first connection. Enforce them in discovery and invocation through both HTTP and MCP, including a direct call to a tool hidden from the caller. Check current grants and identity again on every new call. Isolate connection state by upstream identity so a privileged client's connection cannot be reused for another caller. Do not treat a remote tool's `readOnlyHint` as authorization.

**Complete when:** existing native tools retain their role checks, two test projects cannot borrow each other's upstream authority, a reader cannot invoke an ungranted remote tool, and revocation takes effect for new calls without a server restart. Logs and returned tool data do not expose credentials.

**Why before forwarding:** mounting a privileged service with only the current registry's generic read check would give the wrong callers its authority. This step supplies the needed boundary without building the whole OAuth/account system first.

### 6. Integrate a read-only `mounts` plugin

Make `mounts` depend on the tool registry, credential provider, and declared access-policy contracts. Connect to the real merv-sandboxes `/mcp`, discover its actual catalog and credential requirements, and expose an explicitly selected read-only subset under a namespace. Do not assume the quoted count of 30 tools remains correct or that the Python REST adapter's credential mechanism is accepted by this MCP endpoint.

Implement bounded connection/call timeouts, catalog changes, disconnect handling, and reconnection. Withdraw every mounted tool before draining calls and closing its client. A failed optional mount must not prevent native Merv tasks from functioning. Keep mutation retries disabled unless the upstream operation has a verified idempotency contract.

**Complete when:** a real agent uses Merv to make a permitted read-only sandbox-service call; an admitted call overlaps mount removal; all new mounted calls are refused; native task/review/feed operations continue; and reconnection restores tools without duplicates. Test hangs and connection loss against a controlled MCP fixture, and retain separate evidence for the real service. A fixture-only demonstration does not complete this step.

**Why this limited first integration:** it proves the independent-service boundary without introducing cloud provisioning, spend policy, or recovery from uncertain writes.

### 7. Integrate Nisa through the smallest supported interface

Verify Nisa's documented interface first. Reuse `mounts` if it has a compatible MCP endpoint; otherwise add a small Nisa-owned adapter for its supported API/CLI. Start with search and paper retrieval, using the credential and tool-policy path already integrated. Keep literature retrieval independent of the task and experiment programs.

**Complete when:** a real permitted search returns through Merv, its source references survive the tool transport, disabling the integration removes only its tools, and native work plus the sandbox-service connection continue. No changes to the generic registry or bootstrap are needed merely to recognize Nisa.

**Why here:** this is a small second integration that tests whether the extension mechanism is reusable before we expand central infrastructure.

### 8. Add the new Cordis UI as an optional plugin

Build a small frontend for the new API: project identity, tasks, pinned reviews/artifacts, feed, and component/connection availability. Use the actual HTTP API and controlled local-origin configuration. Keep the UI read-only initially and usable with the existing local credentials. Feature views use exposed capabilities and handle their absence; the UI does not become a prerequisite for domain plugins.

**Complete when:** the UI runs against the new Cordis stack and shows actual records, feed removal changes its available views without breaking task inspection, and mount disconnection is visible. Removing the UI leaves HTTP/MCP functioning. Verify loading, empty, unavailable, and error states in a browser. No old Python backend is involved.

**Why now:** this gives us a visible working product before the larger storage changes. Its HTTP boundary lets the backend change without moving database logic into the browser.

**Milestone A:** a small Cordis Merv, a real external read-only connection, and a working new UI.

### 9. Make State asynchronous, retaining SQLite

Change the State/Sql/Transaction contracts to support awaited operations. Carry the same transaction explicitly through scope, artifacts, workflows, reviews, tasks, and feed; update their adapters and CLI together. Keep SQLite as the only database implementation during this step so interface changes are separated from a database replacement.

Serialize access correctly in the SQLite implementation. A promise-returning callback cannot simply be permitted with the current global active-transaction field: unrelated requests must not join a transaction or read its uncommitted changes. Define transaction lifetime, cancellation, rollback, and draining behavior. Do not hold database transactions open across remote-service calls.

**Complete when:** the complete application, UI, mount, and task/review/feed demonstrations work on SQLite under the new interfaces. Tests interleave requests and force rollback between verdict, transition, event, and dedup writes. Foreign/expired transactions are rejected and unrelated reads do not see uncommitted data.

**Why a separate step:** it is the largest shared contract change. Diagnose it while the database itself stays familiar.

### 10. Add a Postgres State provider

Add a separately selectable Postgres plugin against the contract from step 9. Resolve dialect differences explicitly: parameter binding, generated IDs, migrations, immutability triggers, and conflict handling. Keep migrations owned by the component whose tables they define; provide tested backend-specific SQL where needed. Do not create a general ORM as a prerequisite.

Use one checked-out connection for each cross-component transaction. Handle competing requests using constraints, revision checks, and appropriate transaction isolation. Verify event/feed cursor behavior when concurrent transactions commit out of order; an allocated sequence number must not cause a later commit to be skipped permanently.

**Complete when:** the same behavioral tests pass with SQLite and Postgres, two application processes cannot double-submit a verdict or claim the same review, restart retains the complete task history, and switching the configured provider does not require editing domain implementation imports. This tests alternative providers against fresh test databases; it does not automatically migrate existing Python or SQLite production data.

**Milestone B:** the same small working Merv, now proven against two State implementations.

### 11. Add remote artifact storage

Make the Blobs contract support asynchronous I/O and integrate the existing local implementation first. Then add one object-storage provider selected through configuration. Preserve project namespaces, content hashes, immutable writes, and verification on read. Upload bytes before the metadata transaction; define how unreferenced bytes from failed commits are handled. Do not keep a database transaction open during an upload.

**Complete when:** two Merv processes can read the same completed evidence, corruption and overwrite attempts are detected, a failed upload cannot publish completed metadata, and the task/review/feed loop works using both local and remote storage.

**Why after Postgres:** shared database metadata becomes useful across processes only when the evidence bytes are also reachable. This completes that deployment boundary before adding hosted users.

### 12. Expand project identity and delegated sessions

Separate durable actor identity, project membership, and credentials. First integrate one actor belonging to two projects, explicit project selection, and per-project roles. Then add expiring, revocable session credentials with narrow tool grants, connected to the policy path introduced in step 5. Each of these is its own completed change before the next.

**Complete when:** the same actor accesses two permitted projects, cannot access a third, and a session exposes/calls only its allowed tools through native and mounted paths. A revoked or expired credential fails on the next call. The UI can switch projects and continues to use server-enforced permissions.

**Why after storage:** these are new durable relationships. Add them after the central asynchronous and SQL contracts have settled. Full browser OAuth remains a later adapter onto this identity model.

### 13. Replace placeholder evidence gates and enable the small UI workflow

Give acceptance checks stable identifiers. Require deliveries to map each check to pinned evidence and an explanation; require independent review to record a result and rationale for each check. Validate coverage, ownership, and the immutable snapshot. Structural validation establishes that evidence was supplied; it cannot establish that a research claim is true. Reviewers still inspect the work.

Integrate these changes through the existing native tools first. Then add UI actions for creating a task/brief, supplying delivery evidence, reading the review, and posting to feed. Retain distinct producer/reviewer identities in both API and browser flows.

**Complete when:** missing or cross-project evidence is rejected structurally, a deliberately irrelevant delivery is returned by an independent reviewer, stale submissions cannot change a newer review, and pasting acceptance text alone does not satisfy the delivery format. Fresh producer/reviewer agents complete one accepted task and one revision cycle. The UI displays the same pinned evidence and outcome.

**Why before autonomous execution:** automated agents should receive a meaningful evidence contract rather than learn to pass substring checks.

### 14. Integrate sandbox actions as a separate adapter

Keep generic `mounts` unaware of experiment state and cloud providers. Add a sandbox-specific adapter/policy layer that builds on the verified remote connection, project scope, and session grants. It handles the necessary project namespace and admission policy and records durable command intent/results. Infrastructure secrets, jobs, resource leases, billing, and cleanup remain owned by merv-sandboxes.

Integrate one vertical path: request a bounded sandbox, run a tiny job, inspect it, retain its output as Merv evidence, and release the resource. Select only the required remote tools first. Use upstream idempotency where supported and reconcile ambiguous responses using durable remote identifiers; never blindly repeat provisioning after a timeout. No local transaction can atomically commit an upstream action.

**Complete when:** that path completes through the new stack, a disconnected mount cannot admit new actions, an already accepted remote job retains its independent lifecycle, reconnection recovers its status, and no duplicate resource is created after a lost response. Use a controlled fixture for faults and a bounded, authorized real resource for the complete service demonstration.

**Why after identity and durable storage:** remote actions need scoped authority, recorded intent, and somewhere reliable to retain their evidence. Plugin unload must not be mistaken for resource cancellation.

### 15. Add agent leases and one runner

Introduce Merv agent-work leases and one local runner adapter using the scoped session credentials. These leases coordinate agent assignments; they are distinct from cloud-resource leases in merv-sandboxes. Start with one producer assignment, its handoff, and an independent reviewer assignment. Use an explicit claim/heartbeat/recovery protocol and stable command IDs.

**Complete when:** two runners cannot own the same current assignment, a dead runner's work is recoverable, a stale runner cannot submit against a replacement assignment, credentials expire/revoke correctly, and restarting Merv preserves work and evidence. Connect status to the existing UI and feed.

**Why last in this sequence:** the runner automates capabilities that already work through the API, rather than becoming the place those capabilities are implemented.

## Subsequent order

After step 15, expand one capability at a time:

1. Add one experiment program on the existing workflow, evidence, review, sandbox, and runner capabilities.
2. Add reflection and consolidation only after complete experiments supply their inputs.
3. Add hosted browser authentication through a supported identity provider, then deployment configuration and operational recovery checks. This can move earlier if hosted access becomes a requirement; it must precede public multi-user rollout.
4. Design an explicit import/migration and cutover plan for existing Python Merv data once the destination contracts are stable. Backups, reconciliation, and rollback are part of that work.

Every capability extends the existing tools, UI, and feed in the step that introduces it. Full parity with the Python stack is not the completion criterion for the early milestones.

## Grounds for the ordering

The inspected implementation has synchronous SQL interfaces and raw SQLite SQL in domain components, Zod-only tool definitions, one-project actor records, static bootstrap registration, and no frontend. Those are the actual constraints behind steps 3–13, rather than assumptions about what Cordis automatically provides.

Cordis's loader owns configuration entries and asynchronous tree initialization; the upstream source's `EntryTree.await()` still needs an application readiness policy. See the [Cordis loader implementation](https://github.com/cordiverse/cordis/tree/main/packages/loader) and [Harness's Cordis tutorial](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/). Harness documentation also uses its vendored runtime, so verify the corresponding upstream package API before adopting examples.

MCP's current documented revision is 2026-07-28; earlier revisions use a different initialization model. Therefore protocol compatibility is an explicit step before live mounting, not an assumed benefit of the rewrite. See [MCP versioning](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning).

The credential boundary uses separately validated inbound and upstream authority, consistent with MCP's prohibition on token passthrough. See [MCP authorization guidance](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices#token-passthrough). This does not require building the full OAuth system before a configuration-backed, scoped mount.
