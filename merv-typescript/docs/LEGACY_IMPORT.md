# Existing-project import

The live Python database is **not** a compatible TypeScript database. Import into an isolated schema; retain `public` and its object storage unchanged. A successful import of project names is not permission to switch the UI.

## Observed inventory — 2026-09-16

Read-only, repeatable-read inventory of the existing PostgreSQL database found schema version 81 and 56 public tables:

| Data                       |              Count | Migration implication                                                                                      |
| -------------------------- | -----------------: | ---------------------------------------------------------------------------------------------------------- |
| Projects                   |                 30 | Preserve IDs, names, summaries and creation times.                                                         |
| Memberships                | 43, across 6 users | Every project has members; preserve the same Supabase subjects.                                            |
| Claims                     |                200 | Native statement/scope/status/confidence mapping is possible. Preserve original change history separately. |
| Experiments                |                257 | 223 terminal; 34 still active: 19 running, 12 planned, 2 attempt reviews, 1 design review.                 |
| Tasks                      |                 23 | 20 done, 3 failed.                                                                                         |
| Reflections                |                 76 | 72 terminal; 4 active: 1 consolidating, 2 in review, 1 synthesizing.                                       |
| Artifacts                  |     4,489 complete | 1,589,527,047 bytes. 34 exceed the 2,000,000-byte inline limit; the largest is 342,327,022 bytes.          |
| Research object references |                 43 | These point to sandbox-owned objects; preserve references, not new Merv blob copies.                       |
| Retired storage ledger     |                872 | Includes available, uploading and deleted entries. It is not an inventory of bytes to copy into Merv.      |
| Events / tool ledger       |   29,939 / 125,492 | Preserve ordering, attribution and original IDs as historical facts.                                       |
| Agent sessions             |                510 | All released or expired. Do not resurrect credentials, leases or runners.                                  |

There are also 30 project-synthesis workflows (7 writing), five research waves, ten submitted lens workflows and the old review workflow history. The 34 active experiments and four active reflections cannot be silently represented as executable TypeScript assignments.

## Native mapping

| Legacy source                 | TypeScript destination                                           | Rule                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `projects`                    | `projects`                                                       | Same ID/name/summary/time. Preserve extra legacy settings/status in the archive.                                        |
| `project_members`             | `shared_users`, `actors`, `member_actors`, `project_memberships` | Same verified Supabase issuer/subject, deterministic per-project member actor, no invented bearer token.                |
| Complete `artifacts`          | `artifacts` plus verified destination bytes                      | Same ID, hash, size, MIME and original `created_by` attribution. No upload tokens.                                      |
| `claims`                      | Not imported                                                     | Research claims are retired. The export still carries them and they stay part of the foundation fingerprint.            |
| Standalone `project_api_keys` | Potentially `user_keys`                                          | Both use SHA-256 `mk_` keys. Requires separate policy and exact format validation; not part of the foundation importer. |

The foundation importer ignores `snapshot.claims`: it still checks their shape and fingerprints them, but writes no claim rows, and its receipt counts no claims. The original claim rows remain readable in the history archive. Claims imported before the retirement were converted into Markdown text artifacts titled `Claim: …`.

Legacy membership has no role column. Its HTTP routes explicitly let **any human member add and remove members** (`merv/.../surface/transport/api/projects.py`, add/delete routes). Mapping that existing project administration to `operator` is justified by this policy, not by guessing a project creator. Creation events contain only the project name. The import must not create memberships for users absent from the source.

Derived and OAuth credentials carry audience, expiry, family, parent and quota restrictions that cannot be discarded. Do not activate them as unrestricted TypeScript keys. Old session/review capability hashes and transport sessions remain historical records, not new credentials.

## Research history: proposed compatibility archive

The smallest honest compatibility path is an immutable, project-scoped archive of original research records, with ordinary TypeScript projects/memberships and fresh work using the new plugins. This proposal requires acceptance before cutover. It does **not** resume old active work.

Preserve original rows and IDs for experiments/tasks/claims, attempts reconstructed from immutable workflow history, artifact links, sealed submissions, review requests/sessions/verdicts, reflections/lenses/rosters/corpus, consolidation proposals/decisions, literature, citations, dependency edges, project publications, events and available object references. Keep original JSON and its canonical hash; do not rewrite old evidence into a new review format or assert that old reviews passed the new guards.

A small archive reader can share the existing Scope authorization and UI registry, returning paginated project records and detail/history. One existing UI entry is sufficient; no new domain orchestration plugins are needed. Security-bearing columns (tokens, secret/capability digests, OAuth credentials) are excluded from this reader. Archive record type and source project must be validated on every read; callers cannot provide arbitrary table names.

Native resumability is a separate migration: resolve every producer/reviewer identity, frozen submission composition, attempt boundary, claim, approved-plan reference and graph revision before enabling transitions. A label match such as `running` is insufficient. Until validated, old active work must remain visibly historical and non-dispatchable.

## Bytes and large downloads

Both stores address artifact bytes as `prefix/projectId/sha256`. This permits reuse only when the configured prefix really matches. The staging prefix is separate, so native metadata alone would point at missing objects.

For the 4,455 smaller artifacts, verify every source object's full SHA-256 and exact length, then copy to the isolated destination and verify the write. Complete those network operations before opening the database transaction. Deduplicate verification/copy by `(projectId, hash)` while retaining every artifact metadata row.

The 34 larger artifacts account for 1,478,207,608 bytes. Raising a buffered JSON/base64 read limit to 342 MB is not an acceptable migration fix. The implemented S3 path imports these with bounded streaming verification and conditional server-side copy, then provides authorized 60-second downloads through the existing artifact.read tool. It preserves the original project check, immutable object identity and verification manifest; the inline limit is unchanged. See [production blob storage](PRODUCTION_BLOBS.md#large-retained-artifacts). Sandbox-owned datasets/models remain with their storage owner, including their availability/deletion status.

## Rehearsal and cutover gates

1. Export a consistent source snapshot plus a table-count/content-hash manifest. Preserve a protected source backup. Do not print credentials or research content into logs.
2. Initialize all target TypeScript migrations in an isolated schema; keep automatic dispatch off. The importer requires an empty destination for its first run.
3. Validate project/membership references, identifiers, scientific statuses, source hashes and sizes. Surface unsupported rows explicitly; never skip them silently.
4. Verify/copy immutable bytes outside SQL transactions. A failed later SQL transaction can leave harmless, unreferenced content-addressed bytes; it must not leave half-imported metadata.
5. Insert native records and the import receipt atomically. Same snapshot replays return the original receipt; a changed snapshot under the same import ID is rejected. Do not disable production triggers.
6. Import the agreed historical representation and verify source/target counts and hashes, cross-project denial, representative experiment/review/reflection detail, large downloads, and account access with the same Supabase users.
7. Decide the disposition of active legacy work. Freeze legacy writers for the final snapshot, rerun reconciliation, and only then switch traffic and pause the old UI. Retain an explicit rollback path.

The native foundation importer and bounded large-download path have local protocol and authorization tests. The archive representation and disposition of active work still require an explicit decision and validated rehearsal. No production data has been imported by this work.

The offline foundation call accepts an optional trusted `copyArtifact(projectId, hash, size)` adapter. Wire it to `destinationS3.copyVerifiedFrom(sourceS3, projectId, hash, size)` for the isolated S3 prefix. This adapter is not an API input and must resolve only after complete source/destination verification. Without it, imports larger than 2 MB fail before metadata writes; imports above 512 MiB fail even with the adapter. The 34 observed large artifacts fit this bound. The retired storage ledger is never passed to this artifact transfer path.

## Figure and feed attachments

`planLegacyMedia` derives a fixed inventory from validated history: complete artifacts, complete figures, post images, post HTML embeds and locally retained link-preview images. It follows only retained project/hash references. It never fetches preview URLs or sandbox/storage-ledger objects. A completed figure retains its parent artifact's project, creation time and author plus its original link path. Post files retain the original author handle and post time; this attribution creates no new actor or role.

For media without a retained size, the trusted offline `S3Blobs.copyVerifiedFrom` call obtains a bounded HEAD length and ETag, then verifies the complete source and destination SHA-256 streams. Known sizes must match exactly. The preparation fails if any required object is absent, oversized or corrupt; missing bytes are not silently omitted.

`prepareLegacyMediaFoundation` accepts those trusted receipts, verifies the original native projections still match the protected source history, and appends only actual file metadata. Derived IDs incorporate project, original record type, record ID and attachment slot. Every original artifact ID remains unchanged; collisions with complete or pending historical artifacts fail. The prepared manifest records original/history/prepared fingerprints, exact object receipts and every derived binding. Recompute it from the protected source snapshot when validating a replay; never accept receipts through an agent tool or browser input.

The history UI derives the same file IDs using the small `legacy-media-links` helper, then opens ordinary artifact pages. MIME types outside the safe retained allowlist, including HTML embeds and figures without stored MIME, become `application/octet-stream`. Direct downloads remain attachments with the normal project checks and 60-second expiry. This adds no workflow records, evidence claims or plugin capabilities.
