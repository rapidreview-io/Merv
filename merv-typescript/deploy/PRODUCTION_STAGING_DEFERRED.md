# Forward production release while staging remains fenced

Use an ordinary production release with explicit `--defer-staging REASON`. It retains the normal
boundary gates, production drain/replacement, exact pins, real canary and rollback behavior. It makes
no staging calls and does not claim, drain, deploy, switch, unhold or finish any staging owner.
Do not use another native cutover or clear a staging marker to obtain this behavior.

The reason is recorded in the immutable production plan before deployment. After the actual production
canary succeeds, the VM requires its accepted receipt for the exact image/release, durably writes
`staging-deferred.json`, and includes `staging.status=deferred` in the accepted production state.
The ledger reports production pass and STAGING DEFERRED separately. A failed canary still fails and
uses the existing rollback rules; deferral cannot override an already-started propagation checkpoint.

From the final reviewed integration checkout containing both the Main/reviewer changes and this driver,
with its matching committed Sandboxes checkout and authenticated deployment tools:

```sh
export SBX=/absolute/path/to/reviewed/sandboxes-checkout
node deploy/hosted-release.mjs --host ResearchSuite_Control --sandboxes "$SBX" --check
node deploy/hosted-release.mjs --host ResearchSuite_Control --sandboxes "$SBX" \
  --defer-staging 'Staging native isolation remains fenced pending scoped storage credentials' --dry-run
```

Require production's accepted pins, no active production owner/recovery marker, and a boundary plan
for the reviewer image change. Read-only inspection on October 21 found no production hosted owner,
production maintenance=0 on native Main `0c519ee…`, and no staging hosted owner with staging
maintenance=1 on native Main `e9ed6dbc…`. Recheck immediately before execution; other isolation journals
are separate and must remain untouched.

Before Main recreation, build the final reviewed source and record its actual immutable Docker image
ID (`sha256:` plus 64 lowercase hex digits) in the parent's admission-guard intent. Use that same ID
as `EXPECTED_MAIN_IMAGE` below. Apply the owned Pi admission barrier and let existing Pi commands,
hosts and allocations drain naturally to zero before starting the Main release. Keep admission closed
through public acceptance and the admission guard's exact-image verification; restore only the barrier
owned by this operation before starting the hosted release. Do not relax the guard's identity check.

`--expected-image` compares the freshly built immutable image ID before executing the candidate CLI,
copying live UI files, stopping Main or starting the candidate. A mismatch fails with Main and its UI
untouched by the Main release job. Leave the admission barrier in place, inspect the build and source
difference, and follow the parent's reviewed recovery; never substitute the unexpected ID in the intent
just to make restoration pass. For this sequence, retain `--skip-hosted` so the wrapper cannot perform
hosted work before this check.

The expectation is frozen in the saved remote release job. Observe an interrupted release with
`node deploy/release.mjs --host ResearchSuite_Control --resume RELEASE --skip-hosted --no-rollback`
without `--expected-image`; resume does not rebuild or replace the saved expectation. The option is
rejected with `--resume` or `--retry-prestart`; a prestart retry already requires the retained immutable
build manifest and does not build another image. Omitting it on a new release retains ordinary behavior.

Then parent executes these two separate steps. `--skip-hosted` deliberately prevents Main's wrapper
from starting an ordinary staging propagation; it does not authorize skipping the following hosted run:

```sh
node deploy/release.mjs --host ResearchSuite_Control \
  --public https://experiments.rapidreview.io --sandboxes "$SBX" --skip-hosted --no-rollback \
  --expected-image "$EXPECTED_MAIN_IMAGE"
# After Main public acceptance and guarded restoration of the owned Pi admission barrier:
node deploy/hosted-release.mjs --host ResearchSuite_Control --sandboxes "$SBX" \
  --defer-staging 'Staging native isolation remains fenced pending scoped storage credentials'
```

Require Main release acceptance, then the boundary hosted gates, production canary pass and observed
old runtime stop. Resume the frozen reviewer only after the compatible new hosted image is accepted.
The Main image stays forward on a hosted failure; inspect the hosted result and use its supported
recovery, never an old Main restart. The normal hosted rollback guards remain unchanged.

If the hosted coordinator is interrupted, keep its original committed pipeline and resume:

```sh
node deploy/hosted-release.mjs --host ResearchSuite_Control --sandboxes "$SBX" --resume
```

Resume retains the saved deferral automatically. If specifying the flag again, its reason must match.
It cannot be added to an existing run that did not save it, cannot change the saved reason, and cannot
abandon or skip any propagation already holding both owners. Do not switch pipeline revisions mid-run.

Later staging acceptance uses the supported isolated staging cutover with its own ownership and latest
accepted production source. A production-deferred receipt is not staging acceptance. If staging already
has a prepared source checkpoint, its source-change guard still applies; preserve it and follow its
reviewed forward recovery. The deferral does not make that old checkpoint accept a new source.

Production-only state refreshes (including identical-image rebuilds and successful or failed canary
rechecks) retain any outstanding staging deferral. Later changed releases also retain it unless an
explicit transition supplies a replacement receipt. The retained receipt keeps its original source
run/image; it is an outstanding historical obligation, not a claim that staging runs the latest
production image. A new explicit deferral supersedes that current receipt only after its new
production image passes acceptance. Historical run receipts remain intact. Ordinary staging
propagation alone is not independent staging canary acceptance and does not erase the obligation.
