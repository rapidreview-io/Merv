# Existing-project import (retired)

Production imported the Python system's projects, memberships, artifacts, figures, feed media and research history once, at the cutover on 2026-09-16; the [execution record](../deploy/CUTOVER_2026-09-16.md) has the schema, snapshots, counts and reconciliation. On 2026-09-23 the owner decided there will be no re-import, so the offline importer was removed: the `legacy-rehearsal.mjs` deployment command and its pruning step, the foundation and media importers, and the verified server-side blob copy they used. The 2026-10-10 rollback-retention gate for that decision was waived.

What production still serves from the import:

- The read-only history archive: `src/legacy-history.ts`, its UI adapter `src/legacy-history-ui.ts` and the figure/feed file links in `src/legacy-media-links.ts`, composed when `MERV_TS_LEGACY_SOURCE_ID` names the imported source.
- Imported artifacts as ordinary native artifacts. Those over the 2 MB inline limit (up to 512 MiB) are read through the authorized 60-second download in [production blob storage](PRODUCTION_BLOBS.md#large-retained-artifacts).
- The `legacy_foundation_imports` receipt table and the `legacy-foundation-import` and `legacy-history` migrations. Their published hashes stay pinned by `tests/published-migrations.test.ts`.

The sections below describe the source as it was observed before the import.

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

| Legacy source                 | TypeScript destination                                           | Rule                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `projects`                    | `projects`                                                       | Same ID/name/summary/time. Preserve extra legacy settings/status in the archive.                                            |
| `project_members`             | `shared_users`, `actors`, `member_actors`, `project_memberships` | Same verified Supabase issuer/subject, deterministic per-project member actor, no invented bearer token.                    |
| Complete `artifacts`          | `artifacts` plus verified destination bytes                      | Same ID, hash, size, MIME and original `created_by` attribution. No upload tokens.                                          |
| `claims`                      | Not imported                                                     | Research claims are retired. The export still carries them and they stay part of the foundation fingerprint.                |
| Standalone `project_api_keys` | Potentially `user_keys`                                          | Both use SHA-256 `mk_` keys. Requires separate policy and exact format validation; was not part of the foundation importer. |

The foundation importer ignored `snapshot.claims`: it checked their shape and fingerprinted them, but wrote no claim rows, and its receipt counted no claims. The original claim rows remain readable in the history archive. Claims imported before the retirement were converted into Markdown text artifacts titled `Claim: …`.

Legacy membership has no role column. Its HTTP routes explicitly let **any human member add and remove members** (`merv/.../surface/transport/api/projects.py`, add/delete routes). Mapping that existing project administration to `operator` is justified by this policy, not by guessing a project creator. Creation events contain only the project name. The import created no memberships for users absent from the source.

Derived and OAuth credentials carry audience, expiry, family, parent and quota restrictions that cannot be discarded. Do not activate them as unrestricted TypeScript keys. Old session/review capability hashes and transport sessions remain historical records, not new credentials.

Completed artifact figures and retained feed images, embeds and link previews became native artifacts with deterministic IDs derived from project, record type, record ID and attachment slot; the history UI derives the same IDs with `legacy-media-links`. Historical lineage rows whose bytes were never retained stay metadata-only in the archive. Unfinished legacy work was not resumed; it stays visibly historical.
