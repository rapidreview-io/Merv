# Optional Fleet and Pi — reduced proposal

Design only. Rechecked against fetched main `f17acd4a`. The original proposal is preserved in commit `d937a753`; this revision replaces its scope and sequence. No implementation or infrastructure was changed.

**Decision.** Ship optional workflow Fleet first. Fleet gets machines through Merv Sandboxes; Sessions selects assignments; Runner executes them. Pi follows as a separate optional package that hard-depends on Fleet. Chat uses the same allocation channel without becoming a task. External clients and manually operated runners work without either package.

**Review resolutions.** PostgreSQL only. ToolRegistry owns session tool policy; Scope retains grants and authority resolution. Sessions owns input schemas; its optional API adapter follows current provider registration. No token streaming or heartbeat history in State. No copied dispatch rules. Credential isolation and protected bootstrap are explicit prerequisites, not presumed capabilities.

| Milestone | Deliverable | Exit gate |
|---|---|---|
| 0: Sandboxes prerequisite | Protected fixed-runtime launch and supervisor credential isolation | Both security gates in the prerequisite document pass on the actual Cloudflare runtime |
| 1: Workflow Fleet v1 | Codex as the default harness; one configured profile/source per project, fixed caps, one-assignment Runner, minimal Fleet status/control row | Three independent code.v2 assignments on separate machines, one injected failure, external runner coexistence, retained results and confirmed cleanup |
| 2: Read-only Pi pilot | Agent sidebar, conversations, transient streaming, checkpoint/restore | No fake tasks; authority/reconnect/cancellation tests; token volume does not drive State writes |
| Later, separately scoped | Conversational writes and Pi assignment execution | Transactional authorization proven for every enabled mutation |

Milestone 1 may use three reviewable patches: managed identity/provider consumer, allocator/Runner integration, then UI/acceptance. These form one useful release. Do not build a general platform in intervening phases.

**Go/no-go.** Hosted execution requires both protected bootstrap and OS-user isolation. Existing Sandboxes bootstrap grants its login user passwordless sudo, so launching an assignment as that user fails the isolation gate. If either gate fails, keep hosted execution disabled and use existing external runners. Repair the dedicated launcher/image first. No main-VM fallback or broad source key in the harness. Moving the supervisor outside the sandbox would be a separately reviewed redesign.

**Scope budget.** Start Fleet with two tables: allocation/lifecycle intents and Sessions-owned managed-runner bindings. Configuration supplies fixed caps/profile; existing events record meaningful transitions. Later Pi starts with conversations and commands/outcomes plus existing artifact storage. Add tables only for demonstrated invariants.

No warm pool, generic harness framework, weighted fairness, billing platform, new approval subsystem, general model gateway, separate stream database or multi-user release phase. Basic isolation, revocation and finite caps remain mandatory. One successful assignment per allocation, then capture/release. Simple oldest-request-first admission; no running-work preemption. Chat later shares those caps and releases idle runtimes after checkpointing.

**Current source baseline.** `packages/state/src/postgres.ts` serializes writers with a PostgreSQL advisory lock. `packages/api/src/registry.ts` owns `registerSessionPolicy`; Sessions registers there in `packages/sessions/src/index.ts`. Scope retains session authority resolution and grant policy. Sessions owns its schemas and transport adapter in `packages/sessions/src/api.ts`. Follow these seams rather than reviving old shared schemas or HTTP ownership.

The official Pi [package manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json) currently names `@earendil-works/pi-coding-agent`. Verify the published tarball/provenance and pin an exact compatible release during the Pi milestone; this proposal installs nothing.

Details: [Fleet v1](FLEET_PLUGIN_PROPOSAL.md), [Sandboxes prerequisite and ownership](FLEET_BOOTSTRAP_PREREQUISITE.md), [later Pi pilot](PI_AGENT_PROPOSAL.md).
