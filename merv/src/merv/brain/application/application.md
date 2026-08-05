# Application

## Purpose

Application coordinates product operations that cross module boundaries. It
does not own research state, artifact bytes, sandboxes, feed posts, heavy
objects, authentication, or transport. Those remain with their module roots.
Surface calls one concrete `Application`; module-local tools call their owning
module directly.

## Main flow

`application.py` is the readable root. It composes Research facts with
Artifacts, Sandbox, Feed, and Object Storage only when an operation genuinely
spans them. Research remains the public owner of its event ledger reads.

- `status` and `status_for_agent` preserve rich UI and slim agent views.
- Experiment create/list/get/transition keep released wire behavior while
  Research remains authoritative for state and gates.
- A transition optionally prepares and pins a metrics exhibit, commits through
  Research, applies MLflow effects, then adds a best-effort Feed advisory.
- Review start hydrates the exact snapshot-pinned artifacts and bounded project
  or experiment context.
- Reflection commands delegate lifecycle policy to Research and present either
  compact agent documents or the richer UI overview.
- Dashboard, cost, timeline, graph, and figure-fact reads join facts without
  exposing module internals to Surface.
- Candidate submission resolves and pins an Artifact/Object Storage pointer, or
  records a pathless experiment-workspace nomination for evaluator staging;
  Research owns the immutable candidate and champion lineage.
- Agent-session claims prioritize independent reviews, reviewed-reflection code
  consolidation, then experiments from the latest published wave and other
  active experiments. Owners request review and exit; Merv dispatches a
  separately authenticated reviewer. After consolidation review, the runner
  advances central before Application permits reflection publication.

## Files

- `application.py`: the single public root and visible cross-module workflows.
- `workflow.py`: rich/slim status composition and project-orientation helpers.
- `status_guidance.py`: pure next-action guidance derived from workflow schemas.
- `project_context.py` and `experiments/context.py`: bounded context packets.
- `experiments/transition.py`: experiment transition ordering and exhibit pin.
- `experiments/exhibits.py` and `metrics_exhibit.py`: deterministic observation
  exhibit construction.
- `experiments/presentation.py`, `create.py`, and `claim_guidance.py`: released
  experiment views and compatibility input translation.
- `reviews.py`, `reflections.py`, and `reflection_guidance.py`: review handoff,
  reflection presentation, and guidance.
- `queries.py`: logic-graph composition only.
- `mlflow.py`: the only optional MLflow integration contract and behavior.
- `maintenance.py`: cross-module cleanup ordering.

## Boundaries and invariants

- Research owns workflow transitions, gates, review security, attempt history,
  tracking delivery idempotency, and authoritative state.
- Artifacts owns evidence validation, immutable sealing, and blob-backed files.
- Sandbox, Feed, and Object Storage are called through their concrete package
  roots; Application defines no mirror facades or forwarding ports.
- Agent Sessions owns worker identity and leases; Application only derives the
  dispatchable candidate order from authoritative Research snapshots.
- MLflow is optional. All adapter calls, tracking DTOs, degraded warnings,
  idempotent post-commit run handling, and overview reads live in `mlflow.py`.
- The committed event returned by Research drives post-commit effects. A caller
  command alone is never treated as proof that a transition committed.
- Artifact sealing and Research mutations retain their existing transaction
  boundaries. MLflow and Feed effects occur after commit; Feed and automatic
  MLflow finalization failures remain advisory.
- Large candidates stay in Object Storage. Application validates candidate
  pointers through module roots and never queries sibling persistence tables.
- Surface owns HTTP/MCP models, authentication, formatting, and UI-only
  projections such as `surface/experiment_figure.py`.

## Forbidden regression

Do not recreate a service bag, generic event bus, facade, repository, or
Application-owned port forest. New cross-module behavior belongs as a clear
method on `Application`; module-local behavior belongs on the module root.
