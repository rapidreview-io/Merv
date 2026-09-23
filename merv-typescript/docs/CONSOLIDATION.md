# Consolidation tasks

Research consolidates accepted code through an ordinary Task after independent reflection
approval. The task depends on the accepted units missing from the project base and uses the
normal task delivery, independent review and Code publication path. Research waits for its
publication before completing the cycle. See [Research](RESEARCH.md).

The dedicated `@merv/consolidation` plugin was retired on 2026-09-22. Its package, workflow
registrations, tools, UI and special Code integration are removed. Remove its three entries
(`consolidation`, `consolidation-tools`, `consolidation-ui`) from custom configurations.

The version-retirement migrations then deleted its workflow instances, together with the
retired `research@2`–`5` cycles that used them, and `research@7` dropped its tables, guard
functions and migration receipts; the ids stay listed in `wf_retired_instances` and the
`events` log. Retained Git evidence continues to constrain repository integrity operations.
