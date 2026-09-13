# Reviews

A Cordis service for independent assessment of immutable evidence. Requires `state`, `scope`, and `artifacts`; provides `reviews`. It has no task or workflow dependency.

A request captures an opaque subject ID/revision, assessment criteria, producer identity, and the exact artifact manifest. `snapshotHash` commits to that snapshot. Artifact IDs resolve to immutable content; the stored manifest preserves the metadata assessed at request time. A producer can request review only of their own artifacts. A project operator can request or supersede a review on the producer’s behalf, after an explicit admin permission check; evidence ownership stays with the producer.

`start` checks review permission and producer/reviewer separation, then binds the request to one actor. Repeating a claim by that actor is idempotent. `submit` accepts one verdict (`pass`, `needs_changes`, or `fail`) with nonempty notes. Request and verdict operations reject reuse of a request ID with different content. Submitted verdicts and pinned snapshot fields are protected by SQLite triggers.

All methods accept an existing synchronous transaction where relevant. An integrating program can submit a verdict and change its own state atomically. Review records never invoke a target program themselves.

The optional `reviewToolsPlugin` contributes `review.list`, `review.get`, and `review.start`. The integrating program owns any verdict tool that also changes a target; Merv's Task program owns `review.submit`.
