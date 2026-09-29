# Recovery lifecycle proof

From `merv-typescript`, run with the compiler pinned in `lean-toolchain` on PATH
(or set `MERV_RECOVERY_LEAN_BINARY` to its absolute path):

```sh
node scripts/verify-recovery-lean.mjs
```

The model proves that publishing a verified snapshot preserves the recovery invariant,
staging or failing an incomplete snapshot cannot make it selectable, and deleting one
snapshot cannot change a retained snapshot's files. It also checks the marker-first deletion
rule and requires database/code captures to have the same logical epoch. An axiom audit
rejects unfinished proofs and custom axioms.

This is a proof of the abstract protocol. Snapshot IDs must be distinct; writers must be
excluded during capture; the real verifier must establish `checked`; storage must honor
successful reads/writes. Lean does not prove the Python implementation, filesystem, database,
S3, process isolation or credentials correct. Actual PostgreSQL/Git journal-recovery tests,
failure tests and the deployed restore canary establish separate evidence for those boundaries.

`tests/deployment-recovery.test.ts` runs the executable recovery tests in the ordinary suite.
This standalone proof uses no external Lean libraries and does not modify the separate
workflow-verification project under `verification/lean`.
