# Object Storage

`ObjectStorage` owns research metadata: project-scoped versioned names,
producer associations, upload intents, pinning, retention policy and events.
The independent merv-sandboxes service owns physical objects, transfer sessions,
provider credentials, integrity verification and physical cleanup.

## Files

- `storage.py`: research object ledger, completion tokens, policy and projections.
- `provider.py`: byte-transfer port and immutable object statistics.
- `__init__.py`: public research object API.
- `../infrastructure/storage.py`: ObjectProvider implementation for ML workload
  transfers through merv-sandboxes. Research evidence uses a separate R2 client.

## Transfer and compatibility

1. `submit` validates a display path, digest and size, then registers a research
   ledger row. Bytes are named by SHA-256 inside `merv-project-<project_id>`.
2. The infrastructure service allocates resumable multipart upload targets.
   `merv-client` verifies the local digest, uploads missing parts, and returns
   through Merv's expiring completion token. Empty files complete without PUTs.
3. Completion reserves the ledger row before asking the service to verify and
   finalize bytes. Namespace, digest and size must match the durable intent.
   After a crash, content lookup recovers a successful remote completion.
4. Research resolution renews the logical retention window. Pinning removes
   its expiry; deleting the final reference delegates physical deletion.
5. Existing object IDs, versions, names, experiment associations, content hashes
   and submitted evidence references remain unchanged across the migration.

## Submitted evidence

Artifacts, Feed and tool-call payloads belong to Merv. They use its own
`artifacts/r2.py` byte provider and dedicated R2 bucket, addressed by project
namespace and SHA-256. Tool-call ledger cleanup deletes its expired payloads;
research evidence remains durable. These bytes never use the ML storage API.

## Invariants

- Research authorization runs before a namespace-scoped service call. Clients
  never receive service JWTs or provider credentials.
- Names and deduplication are project-scoped for heavy objects; bounded evidence
  remains behind its owning module's authenticated routes.
- The ObjectProvider boundary moves bytes and does not change research policy.
- Public MCP schemas, completion tokens and research events remain compatibility
  boundaries. New physical upload IDs are opaque `msbx_` service references.
- Legacy physical keys are imported into merv-sandboxes before cutover. Merv
  itself keeps no legacy provider path or fallback to the old storage store.
- `by_experiment` reads metadata even when the service is not configured.

Changes to command generation, completion/retry, authorization, limits or
response shapes need meaningful transfer and HTTP/MCP coverage. Schema/event
changes require compatibility tests for existing research databases.
