# Fleet

Fleet is a default-disabled, server-side capacity and sandbox lifecycle service. It does not run research work or expose allocation requests as agent tools. A trusted workflow or chat owner must register to validate authority, provide stable bootstrap bytes, and report when capture or checkpoint work has finished. No production owner is registered yet.

An allocation uses one immutable runtime profile and one stable create and launch key. Global and per-project limits count provisioning, uncertain, and deleting allocations until the sandbox provider reports `stopped`. A deletion request or an expired or consumed bootstrap receipt does not release capacity. `drain` prevents new admission and launch while renewing a running sandbox until its owner finishes or the allocation deadline expires.

Fleet writes a `createAttempted` marker before contacting the provider. A canceled allocation with no attempt can be released without renting a machine. After an uncertain create reply, Fleet repeats the same idempotency key to recover the sandbox and delete it. If the operator changes the fixed runtime profile before that recovery, Fleet retains the occupied slot and makes no create call under the new profile. Restoring the prior profile or operator reconciliation is required to resolve that uncertainty. Existing known sandbox handles remain inspectable and stoppable across a profile change.

The service does not prove a runner is alive from the Sandboxes launch receipt. The owner observes runner enrollment and completion. Fleet admission requires a confirmed launch, current source authority, matching epoch and profile, and `run` intent. Shutdown fences admission, requests cleanup, and leaves pending provider deletion for a later controller to reconcile.
