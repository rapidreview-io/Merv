# Sandboxes terminal-report boundary

The late-create / false-terminal race reproduced against provider HEAD
`c7b9582faf5a4760230ae26d04b9079b1f8e6907` is repaired in the local provider
working tree. The original real PostgreSQL regression now passes, including
cleanup of the late machine. The original baseline and the repaired candidate are also exercised in disposable databases on the production host; no cloud machine is rented. Shared production services remain unchanged by these tests.
The guarantee applies to newly admitted work under the repaired protocol and the
provider assumptions below; legacy rows require the cutover treatment below.

The old schedule paused worker A immediately before `driver.create`, cancelled
the sandbox, and let worker B report `STOPPED` after a recover miss. A then
created a live machine behind that terminal report. The historical counterexample
remains in `BackendProviderBoundary.lean`; its `Durable` namespace models the
implemented repair rather than the old unfenced worker.

## Minimal repair and ownership

There are two new durable columns, no operation journal or process-local lock:

- `sandboxes.create_phase`: `not_started`, `pending`, or `settled`.
- `work_items.generation`: a monotonically increasing claim generation, separate
  from the retry counter which resets when an item is rearmed.

The registry owns admission and settlement. `admit_create` locks the sandbox row,
requires provisioning + not_started + the current running queue claim, and commits
pending before calling the driver. Deletion uses the same row serialization
domain, closes admission, and enqueues cleanup in the same transaction. The
admitted bootstrap identity is saved in the admission transaction too. At most
one driver create is admitted during a sandbox's lifetime; retrying a queue item
cannot admit another call.

Only that call's successful return or explicit `CreateRejected` (a definite
no-effect refusal) settles it. Native ID and settlement are saved atomically.
Settlement deliberately accepts evidence from an expired claimant: it resolves
the already admitted effect, even though that claimant can no longer finish the
queue item. Settlement also rearms cleanup if deletion has started or provisioning
has failed. Recover can save a discovered ID and cleanup can delete that resource,
but neither a recover hit, miss, timeout, cancellation, nor queue expiry settles
the outstanding call. Every registry transition to STOPPED checks the durable
phase in its actual database UPDATE, including presence reconciliation.

The queue owns claims. Complete, retry, fail, and heartbeat require the item to
still be running at the same generation. Reclaim and rearm cannot make an old
callback current again. Provision failure changes the sandbox and consumes its
claim in one transaction. Deletion errors keep retrying, including nominally
nonretryable provider errors: otherwise a late result's wakeup could be lost when
it arrives while a failing delete claim is still running. Fixing credentials or
provider availability can therefore resume cleanup.

`FAILED` is not a provider terminal observation (`SandboxState.terminal` includes
only STOPPED). A failed create with an ambiguous outcome remains visibly pending;
its delete request remains DELETING until the admission is resolved.

## Provider and crash limitations

The worker no longer assumes lookup-then-create is safe to replay. Local source
inspection shows that DigitalOcean lists by operation tag before a POST, Lambda
uses lookup plus a launch request, and the local driver uses process-local locking
and filesystem metadata. These are not a general cross-process idempotency or
remote settlement fence. AWS sends a `ClientToken`, but this repair does not infer
an unlimited finality guarantee from that adapter detail. No cloud behavior was
verified here.

The remaining assumptions are explicit: one successful driver call returns the
identity of its only resource, has no hidden retry capable of later producing a
sibling, and provider-confirmed absence of that settled resource is truthful.
Definite refusal must mean no present **or future** effect. Only the fake driver
was changed to emit `CreateRejected`, at a branch before any effect. Ordinary SDK
exceptions remain ambiguous. Drivers creating unreported siblings or falsely
reporting absence are outside this proof; discovery APIs do not resolve those
limitations.

A crash after durable admission and before recording the definitive return can
retain uncertainty indefinitely—even when the call never reached the provider.
After a crash with an actual resource, recovery can delete the known resource,
but cannot certify that all future effects have settled. There is intentionally
no timer-based clear, blind replay, or new force-settlement endpoint. This is a
safety/availability tradeoff; unconditional recovery or liveness is not claimed.
A crash after settlement can resume normal provisioning/cleanup without another
create. A late result that still reaches its original caller resolves pending and
lets deletion finish.

## Migration and cutover

The release candidate preserves live revision `0287040` and appends
`0029_create_admission` after `0028_member_storage_limit`. The original working
repair used revision 0025 on its older base. It adds columns and a
phase check constraint without rewriting retry counters or existing API intent.
New registry-created sandboxes explicitly start not_started. The server default
is pending so writers/import paths without admission evidence fail closed.

**Drain old workers before migration/code cutover; mixed-version workers are not
safe.** Existing active rows all become pending, even when they have a native ID:
old state and queue claims cannot prove the absence of another late create.
They need independently justified reconciliation before an operator can clear
that uncertainty. This implementation supplies no automatic backfill pretending
to have that evidence. Existing STOPPED history remains STOPPED/settled for
compatibility, but its old terminal claims are not retroactively certified; audit
it separately for the previously reproduced race. Downgrade refuses to discard
admission evidence or generation fences. Parent owns the production plan/tests.

## Proof and deterministic checks

The Lean `Durable` model separates admission, physical effect, settlement, queue
ownership, discovery, deletion, and capacity release. Its records hold ordinary
data. Arbitrary-trace theorems prove terminal soundness (no live machine and no
future effect), capacity safety, irreversible admission, permanent terminal state,
and stale callback/admission/failure fencing. Concrete traces prove normal,
no-create, refused-create and late-result cleanup progress, while crash/recovery
traces explicitly retain uncertainty. The earlier Fleet refinement theorem remains
conditional on this truthful provider boundary. Lean does not verify Python,
PostgreSQL, the provider SDKs, or an arbitrary migration from corrupted old state.

| Runtime behavior                                               | Lean counterpart / PostgreSQL regression                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Durable create admission before the driver await               | `admit`, `admission_stays_closed`; cancellation before admission and concurrent admissions                               |
| Paused create cannot be terminalized                           | `late_create_retains_capacity`; external late-create regression                                                          |
| Expiry/rearm does not authorize another call or stale callback | `stale_callbacks_preserve_successor`, `stale_admission_is_noop`; all four callbacks after reclaim and rearm              |
| Late settlement saves ID and wakes cleanup                     | `late_settlement_cleanup_progress`, `settlement_wakes_cleanup`; failed and running cleanup schedules                     |
| Delete failure does not consume settlement wakeup              | `settlement_then_delete_failure_progress`; overlapping nonretryable lookup failure                                       |
| Crash/ambiguous reply retains pending through recovery         | `crash_and_recovery_do_not_settle`; recovery hit, miss, worker cancellation and restart                                  |
| Ordinary work still progresses                                 | `normal_progress`, `definite_refusal_progress`; fake refusal, local driver, pre-admission retry, post-settlement restart |

`control/tests/test_lifecycle_fencing.py` uses the real database, registry, queue,
and workers. It also checks transaction rollback for intent/enqueue and
settlement/wakeup, plus upgrade from populated revision 0028. All providers used
in these checks are fake or local. The external regression stays outside the
TypeScript suite because the Python provider is a separate repository.

From the provider `control` directory, run the external regression separately
(the internal suite auto-loads its conftest):

```sh
PYTHONPATH=.:src SANDBOXES_TEST_DATABASE_URL=postgresql://merv@127.0.0.1:55439/postgres \
  .venv/bin/python -c 'import sys; sys.modules["readline"] = None; import pytest; sys.exit(pytest.main(["-c", "pyproject.toml", "-q", "-p", "tests.conftest", "/path/to/Merv/merv-typescript/verification/provider-boundaries/test_sandboxes_terminal.py"]))'
```

The `readline` assignment works around a local Python 3.11 pytest-import crash
and affects only that test process. Compile only `BackendProviderBoundary.lean`
with Lean 4.34.0 and the already-built FleetRelease import on LEAN_PATH. The module
passes warnings-as-errors; the audited theorems use only standard Lean axioms
(propext, Classical.choice, Quot.sound), with no sorry or custom proof axioms.

The final combined provider run passed 132 tests across lifecycle, registry, API,
access, tunnel, jobs, local-provider, billing, workflow-lifecycle and import checks;
the separate external regression passed once more (133 passing checks total).
Ruff and focused mypy checks passed. These are local tests, not production tests.

Negative controls run only in scratch pytest processes: omitting durable admission
makes the original test report STOPPED before the late create; omitting the queue
generation predicate makes all eight stale-callback schedules fail. No source was
left mutated by these controls.

The provider's pre-existing user edits in the two API files, registry renewal,
and API tests were retained. Their before/after diffs and test logs are recorded
under `/tmp/merv-infra-hardening`; the original patch still reverse-applies cleanly.

The integrated broad provider run reported 761 passes, 27 skips and 14 failures.
All 14 failures reproduced on the unchanged live-source baseline in the same
local environment (bootstrap fixtures, timezone-sensitive usage and retained
workflow replay). The final targeted integration checks passed 114 tests. The
production canary has its own result in the infrastructure verification report.
