# Archived research claims

The claims feature is retired. The living paper holds hypotheses and conclusions,
with named experiment links leading to their plans, evidence and reviews.

`@merv/claims` retains only the original storage migrations and project-scoped,
read-only `get`/`list` operations. It has no creation or update API. Knowledge
exposes these records as `project.records.archivedClaims` and resolves historical
`claim:ID` references. The paper’s Details view makes the archive readable.
Existing experiment links, snapshots, event history and command receipts remain
unchanged. Reviewer claim IDs are independent assignment locks and are unaffected.

The old tools/UI entrypoints register nothing, so older configurations still boot.
New configurations omit those adapters. No data is deleted or copied into the paper
without a contextual editorial decision.
