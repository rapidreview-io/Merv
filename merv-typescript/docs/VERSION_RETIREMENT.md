# Workflow version retirement

On 2026-09-22 the owner retired every workflow version that can no longer be started and chose
to delete the records of its instances. Commit `99c392f0` removed the code for those versions and
added ten migrations (workflows@7, sessions@6, tasks@8, reviews@10, context_builder@2,
experiments@4, experiment_program@3, reflections@2, research@7, knowledge@2). They share the
retirement ledger `wf_retired_instances` (kept permanently: it explains ids that the event log
names but no table holds anymore). The event log, artifacts, paper history and Code lineage are
kept. `scripts/retirement-census.sql` is the census run before and after.

## Releases

| Environment                           | Release                                  | Census before                                                                                                                                 | After                                                                                                                                                                                                                                 | Backup                                                                      |
| ------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Staging (`merv_ts_staging`)           | `20260923T022622Z-99c392f0-13937dc55496` | nothing to retire                                                                                                                             | all ten migrations applied, no disabled triggers                                                                                                                                                                                      | `/var/backups/merv/version-retirement/20260923T022603Z`                     |
| Production (`merv_ts_prod_20260916a`) | `20260923T022834Z-99c392f0-13937dc55496` | 16 retired instances: experiment@3 (10), experiment@4 (3), research@3 (3); 663 of their worker sessions; no live sessions, no refused records | ledger 16; instances 21 → 5; experiments 13 → 0; research cycles 3 → 0; worker sessions 844 → 181; reviews 80 → 17; tasks 5 and artifacts 4,161 unchanged; events 9,454 unchanged; no disabled triggers; consolidation tables dropped | `/var/backups/merv/version-retirement/20260923T022606Z` (26.6 MB `pg_dump`) |

One surviving, finished task@2 had a dependency edge to a retired experiment; the edge was
removed. Both servers started with 50/50 plugins active and zero restarts.

Rolling back the image alone fails with `migration_ahead`; recovery means restoring the backup.
