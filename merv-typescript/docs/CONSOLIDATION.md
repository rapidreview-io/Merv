# Consolidation tasks

Research consolidates accepted code through an ordinary Task after independent reflection
approval. The task depends on the accepted units missing from the project base and uses the
normal task delivery, independent review and Code publication path. Research waits for its
publication before completing the cycle. See [Research](RESEARCH.md).

The dedicated `@merv/consolidation` plugin was retired on 2026-09-22. Its package, workflow
registrations, tools, UI and special Code integration are removed. Remove its three entries
(`consolidation`, `consolidation-tools`, `consolidation-ui`) from custom configurations.

Existing database and Git records are retained without rewriting approvals or deleting
history. The retired workflow has no execution or publication provider. A pre-version-6
research cycle that requires that workflow reports `research_consolidation_retired`; start a
new research cycle to use consolidation tasks. Previously committed Research command receipts
still replay. Retained Git evidence continues to constrain repository integrity operations.
