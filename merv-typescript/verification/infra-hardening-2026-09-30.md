# Infrastructure interruption hardening — 2026-09-30

This integration starts from Merv `7ccfc3a9aca671a5cf7dc0f30683faa13c84ac7a`.
It contains infrastructure changes and their verification. The earlier Code and
Code Research work remains in the separate `code-lean` checkout.

## Ownership and implementation

- API owns registration fencing. State owns connection lifetime. Domain Events
  owns delivery scheduling. Their earlier small fixes are included here.
- Fleet and Pi each own their accounting receipt table. A reservation and daily
  charge commit together; usage and its receipt commit together. Identical
  settlement retries preserve the first charge and its original day.
- The shared relay waits for accounting before forwarding a terminal with usable
  usage. Cancellation ends the HTTP wait without cancelling the database write.
  Callback errors cannot turn into an acknowledged successful completion.
- Sandboxes owns its create admission and queue claim generation. Its separate
  candidate retains uncertainty across crashes and stale claims, wakes cleanup
  on late settlement, and commits bootstrap identity with claim-checked admission.
- Process barriers and crash scheduling live only in test fixtures. No plugin
  gains a fault-injection framework, shared saga service, or recovery daemon.

## Production evidence

Tests use disposable data on `ResearchSuite_Control`, the production host. They
use production PostgreSQL and object storage under exact synthetic schemas and
prefixes. They do not kill shared services or run research workloads.

- Deployed Merv image `40aa74dcc05622f7710782b3236ea339b8b645cf1eeda110e5f0ea3c4aa2e316`:
  storage retry and signed download passed. The event-poll regression failed:
  one committed application row, zero consumer effects.
- The same image with the compiled API/State/Domain Events fixes mounted into an
  isolated canary passed ten storage, permission, delivery and reopen checks.
- Deployed Sandboxes image `e19f2a05a66c77918d049bdc012ce3fd85eac99602deb9a673f2e6139bf5322d`:
  the late-create regression failed with STOPPED followed by PRESENT. It used
  real registry/queue/workers and PostgreSQL with a fake cloud driver; no cloud
  machine was rented.

- The complete immutable TypeScript candidate `a7cc14243` passed all twelve checks,
  including Fleet and Pi settlement replay after reopening the database connection.
- Sandboxes candidate `4f7aea5`, based on the deployed `0287040` source, passed 42
  checks on the production host with disposable databases.
- All three synthetic schemas and their three objects were removed; their object
  prefixes were confirmed empty. No provider test databases remained. Shared
  services were running after cleanup.

Exact source/image hashes, scenarios and log hashes are in
[the verification record](infra-hardening-2026-09-30.json). These were isolated
canaries. This work did not switch either shared service or migrate its live schema.

## Local validation

The Lean audit passed over 4,923 declarations and 216 required theorems, rejecting
both injected custom axioms and unfinished proofs. All 181 Lean/conformance tests
passed, including implementation mutations and real child-process crashes.
Ordinary TypeScript tests passed: 2,751 passed, one optional Nisa cross-repository
check skipped. Release-script tests passed: 59. Server/browser typechecks,
production-image builds, formatting and the architecture map check passed.

The final provider targeted suite passed 114 tests. A broader run before the last
race refinements had 761 passes, 27 skips and 14 failures; all 14 failures also
reproduced on unchanged deployed source in the same environment. They concern
bootstrap/vault fixtures, timezone-sensitive billing/usage and historical workflow
replay. The full provider suite is not claimed green.

## Limits and rollout

Unknown create outcomes remain pending; provider lookup cannot certify settlement
of a paused or crashed request. The repaired Sandboxes migration must not be
applied to the live registry merely because its new-record tests pass: existing
active rows lack the required admission evidence. The two ready machines observed at initial inspection
and stopped history need an evidence-backed migration disposition. The provider
candidate is integrated on the live `0287040` source, preserving its later APIs
and migrations and appending `0029_create_admission` after `0028`.

Relay outcomes lost before persistence retain their reservation. No autonomous
usage reconstruction, exactly-once remote effects, or hard provider billing bound
is claimed. Receipt retention remains conservative. A forwarded terminal with
malformed usage does not establish successful accounting.

Lean proves the stated models. Tests compare selected real executions to those
models, including real process death before/after commit. They do not verify
PostgreSQL durability through power loss, all provider implementations, or every
production schedule. The general test suite is for a scratch database; only the
explicitly isolated acceptance scripts are used with production infrastructure.
