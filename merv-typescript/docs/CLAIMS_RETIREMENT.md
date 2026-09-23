# Research claims retirement

Research claims were retired as a feature on 2026-09-21 (`5b204057`). On 2026-09-22 the owner
decided to retire the stored claims too: every claim became a text file stored as an artifact,
and the claims plugin, its tables and all code that read them were removed.

## How the conversion worked

Release `1ce9f9cc` carried a one-time step in the artifacts plugin (`9dc35ed3`). At startup, if a
`claims` table existed, it wrote each claim as a `text/markdown` artifact titled `Claim: …`, then
dropped `claims` and `claim_commands` and their guard functions and removed the `claims` rows
from `component_migrations`, all in one transaction. Each file holds:

- the statement, status, confidence and scope;
- the original author and times, or a note that the claim came from the 2026-09-16 legacy import,
  whose author and revision history were not carried over;
- the edit history from the claim's `claim.created`/`claim.updated` events;
- the stored row as JSON, exactly as it was.

The artifact keeps the claim's original author and creation time, and its id is derived from the
project and claim ids. The claim events stay in the event log. The step was removed from the code
once both databases had run it.

## Releases

| Environment                           | Release                                  | Before                                                                    | After                                                                                                           | Backup                                                                                               |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Staging (`merv_ts_staging`)           | `20260923T021429Z-1ce9f9cc-72daa99ac859` | 0 claims, 0 artifacts                                                     | claims tables absent, 0 `claims` migration rows                                                                 | `/var/backups/merv/claims-retirement/20260923T021420Z`                                               |
| Production (`merv_ts_prod_20260916a`) | `20260923T021647Z-1ce9f9cc-72daa99ac859` | 209 claims (200 legacy import, 9 native), 3,952 artifacts, 9 claim events | 209 `Claim: …` artifacts, 4,161 artifacts, claims tables absent, 0 `claims` migration rows, 9 claim events kept | `/var/backups/merv/claims-retirement/20260923T021634Z` (26.6 MB `pg_dump`, includes the claims rows) |

Both servers started with 50/50 plugins active and zero restarts. The production readiness line
appeared about 100 seconds after the container started, after `release.mjs` had already read the
log, so its row was completed by hand from the readiness line.

Restoring the claims as rows needs the backup; rolling back the image alone recreates empty claims
tables.
