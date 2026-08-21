# Sandbox module

## Purpose and boundary

`merv.brain.sandbox` is the control plane for temporary research compute.
`SandboxEngine` is the application-facing API; `SandboxBackend` is its one
injected provider contract. Composition alone imports concrete construction
code. Sandbox owns reservation, provisioning, attachment, observation,
extension, release, cleanup, and compute accounting. It does not own research
workflow, authentication, HTTP/MCP rendering, or artifact/blob persistence.

## Main flow

1. `adapters.build_sandbox_backend` lazily selects one provider or builds a
   `MultiplexingSandboxBackend` for several. Provider-qualified IDs keep every
   later operation routed to the resource's durable owner.
2. `SandboxEngine.request` validates the request, applies quota policy, and
   reserves a durable `provisioning` row. The row—not a worker thread—is the
   source of truth.
3. `SandboxProvisioner` acquires compute asynchronously. It revalidates the
   adapter's final pre-launch quote against spend policy (`on_quote`), then at
   `on_created` atomically persists the native resource ID AND opens the spend
   generation — accrual starts when the billable resource exists, boot
   included. Publishing `running` finalizes that generation.
4. Reads use one row-derived `SandboxTarget` for provider, SSH, work directory,
   and key coordinates. Observation caches and reconciles remote runs, metrics,
   and transcript bytes.
5. The idle sweep already samples every running row, so it also records a
   bounded usage series. The project list projects that plus the last command
   per row, which is what makes a whole fleet observable without one SSH read
   per viewer; single-sandbox and agent views keep the narrower shape.
6. Release, provisioning failure, expiry, idleness, and crash recovery converge
   on `SandboxLifecycle`. `SandboxScheduler` supplies cadence; it does not own
   lifecycle decisions.

## File map

- `__init__.py`: public imports; `core.py`: application-facing operations and
  wiring; `models.py`: protocol, request/target values, statuses, fences, and
  the fail-closed backend used when composition disables Sandbox.
- `storage.py`: scoped SQL, attachments, generations, events, and
  compare-and-set transitions.
- `provisioning.py`: asynchronous acquire/cancel recovery; `lifecycle.py`:
  destructive and recovery transitions; `scheduler.py`: timer ordering.
- `observation.py`: run ledger, remote run reads, metrics, and transcript cache;
  `heartbeat.py`: idle-reaping policy plus the bounded usage series the fleet
  view reads; `quotas.py`: admission and spend, including per-user per-provider
  daily caps (commitment-based: accrued + committed lease burn vs the cap);
  `budget.py`: the sweep's warn → over_budget → grace → terminate ladder.
- `adapters/provider_catalog.py`: connectable-provider specs (fields, wizard
  help, env detection) and `adapters/credential_check.py`: one cheap
  authenticated call per provider — both behind Sandboxes → Configure.
- `keys.py`: management-key adapters; `sandbox_paths.py`: canonical remote
  paths. Lifecycle keeps process-local, write-only pending secrets.
- `adapters/__init__.py`: lazy registry, factory, aliases, and multi-provider
  routing; `adapters/base.py`: shared configuration/HTTP/catalog and VM+SSH
  mechanics.
- `adapters/{lambda_labs,thunder_compute,modal,hyperstack,digitalocean,verda,
  voltage_park,tensordock,aws,gcp,azure}.py`: one explicit provider adapter per
  file.
- `remote/bootstrap_tools.py`, `remote/vm_bootstrap.py`, and
  `remote/vm_ssh.py`: portable remote setup and SSH execution.
- `remote/run_receipts.py`, `remote/transcript_wire.py`, and
  `remote/usage_metrics.py`: bounded remote wire formats and parsers.

## Safety and consistency invariants

- Provider failure is unknown, never proof that a resource is gone. Only
  confirmed absence permits a terminal row; uncertain destruction remains
  visible as `cleanup_pending` and is retried.
- Destructive transitions are fenced by `sandbox_uid`, project ownership,
  status/phase, cleanup token, and row version. Heartbeats and endpoint refresh
  cannot advance a cleanup claim.
- New IDs are `<provider>:<native-id>`. Legacy IDs are qualified from the row's
  recorded provider; an unavailable owner fails closed.
- An experiment has at most one default active sandbox. Explicit attachments
  control sharing; every state operation remains project-scoped.
- Expiry, final receipt observation, idle judgment, stale provisioning, and
  cleanup retry remain ordered so detached work is not destroyed prematurely.
- Terminal state closes compute spend and removes management keys and transient
  secrets. Valuable outputs must be retained before confirmed release.
- Provider adapters translate errors into the shared taxonomy, call
  `on_created` as soon as an ID exists, and avoid optional SDK imports until
  selected. Shared VM code may encode only truly common SSH/bootstrap behavior;
  provider-specific auth, procurement, billing, and state mapping stay explicit.
