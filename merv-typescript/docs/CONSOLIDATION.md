# Consolidation from retained sources

Consolidation requires State, Scope, Artifacts, Workflows, Reviews, Context Builder and Code. It has no Reflections dependency or contract import.

Consolidation is an optional stage of Research. New research cycles select it only for Git code changes; cycles with no code changes complete after approved reflection. Code remains mandatory inside Consolidation so a selected Git stage cannot run without its commit and proposal service. Experiments and Knowledge retain their optional Code integrations independently.

`consolidation.create` accepts `sourceArtifactIds` (required), `experimentIds` (the decision scope), `workspace`, optional `dependsOn`, name and requestId. It validates every source in the caller's project and freezes artifact metadata and hashes. The originating workflow selects and verifies approved inputs. Research performs that check through Reflections before calling Consolidation, and supplies the reflection as a durable prerequisite. Standalone callers may consolidate other retained sources; supplying an artifact does not itself assert independent approval.

The worker must submit exactly one retain/adapt/drop/no_code decision per selected experiment. Git mode seals the current worker's successful commit and evidence into an exact proposal. The retained report-only mode permits drop/no_code and remains supported for existing version-2 research cycles; their selected stage and saved records are not reinterpreted. Existing independent consolidation review returns only to consolidating, or completes the work. Completion does not publish central Git.

Context and grants use pinned source artifacts and the current submission. Prerequisite success states are durable Workflows records, so completed reflection prerequisites continue to be satisfied after the Reflections plugin unloads. Historical records containing an embedded reflection are read as artifact sources directly from their retained bytes; no upstream service is called.

Source selection, domain records, review requests, transitions, replay receipts and completion records preserve their existing transaction and immutability boundaries. Artifact content remains behind Artifacts/Blobs. The UI accepts source artifact IDs and shows retained sources without querying reflection.list; the Reflection page can prefill these sources for an approved wave.
