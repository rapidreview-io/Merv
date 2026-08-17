# Object Storage

## Purpose and ownership

`ObjectStorage` owns project-scoped heavy-object metadata and lifecycle:
versioned names, producer associations, upload intent/completion, retention,
pinning, access renewal, reclamation, and durable storage events. Heavy bytes
stay outside the database and move directly between callers and an
`ObjectProvider` over presigned URLs. The provider does not own project policy,
and the narrow blob store used by Artifacts and Feed does not own heavy-object
metadata merely because it also persists bytes.

The concrete root is exported from `object_storage.__init__`. Tool and HTTP
delivery call it directly. Application depends only on `ProducedObjectCatalog`
for the genuine cross-module experiment projection.

## Files

- `storage.py`: the `ObjectStorage` root, lifecycle SQL, commands, completion
  tokens, response projection, cleanup, and events.
- `provider.py`: typed heavy-byte transfer boundary and provider statistics.
- `s3_object_store.py`: S3/R2/MinIO single- and multipart-presigned transfer,
  checksum/size verification, provider sidecars, and SDK credentials.
- `blobs.py`: local filesystem bytes for Artifacts and Feed.
- `s3_blobs.py`: S3 bytes for Artifacts and Feed.
- `__init__.py`: root export plus the released lazy S3 provider export.

## Heavy-object flow

1. `submit` validates the local display path, kind, digest, and size caps, then
   registers a versioned ledger row. Existing physical content is reused only
   inside the project namespace; the same name and digest is idempotent.
2. New content receives a provider upload target. Up to 5 GiB, the returned
   shell command binds SHA-256 and content type into one presigned PUT. Larger
   objects invoke `merv-client`, which verifies the local digest, streams
   presigned parts concurrently, and posts their ETags for completion. Provider
   URLs are fetched through the one-time token and never enter agent context.
3. Completion reserves the ledger row as `completing` before provider work.
   Provider identity and size must match the durable row. A retry after the
   provider succeeded but before the ledger commit re-stats the immutable
   content and converges.
4. The successful transaction marks the row `available`, starts the default
   TTL, records access time, and emits `storage.completed`. The opaque token is
   deleted only after completion succeeds, making it expiring and single-use
   without turning a transient pre-upload failure into permanent loss.
5. `find` either lists the project ledger or resolves one available version.
   Resolution renews only forward, records access, and optionally mints a
   download URL. `fetch` adds a caller-run SHA-256 verification command.
6. Pin clears expiry; unpin/renew restore the default window. Delete and expiry
   retain ledger history, emit their durable events transactionally, and
   reclaim provider bytes only after no uploading, completing, or available row
   references the same project-scoped digest.

## Binary blob boundary

Artifacts and Feed consume only `EvidenceBlobStore.put/get`; cleanup consumes
`ExpiringBlobStore.sweep_expired`; the tool-call payload ledger
(`kernel/state/tool_call_payloads.py`, namespace `tool-calls`) additionally
uses `DeletableBlobStore.delete` to drop each record by key when its ledger
row ages out. Local and S3 implementations preserve content addressing,
namespace isolation, idempotent writes, content type, and extend-only expiry.
They do not expose a second presigned upload lifecycle. Bounded Artifact/Feed
uploads are authenticated and capped by their owning modules before those
modules write bytes.

## Invariants

- Every ledger read and mutation resolves the project through
  `BaseStateStore`; namespaces are project IDs, so deduplication cannot reveal
  content across projects or tenants.
- Public MCP tool schemas, hidden maintenance tools, HTTP routes, and result
  dictionaries are compatibility boundaries. Provider targets are internal.
- `storage.submit` defaults to 50 GiB per object. A project may override
  `storage_max_upload_bytes`; the deployment's `MERV_STORAGE_MAX_UPLOAD_BYTES`
  remains the absolute ceiling. Objects above 5 GiB use multipart transfer.
- SHA-256 key validation, checksum-bound single PUTs, client-side full-digest
  verification for multipart, provider size verification, and completion
  identity checks protect the content-addressed ledger.
- `storage_objects`, `storage_completion_tokens`, their migrations/indexes, and
  `storage.registered/completed/deleted/expired` payloads are durable formats.
- Provider credentials and SDK calls stay in `s3_object_store.py`. Root methods
  accept no provider-specific arguments.
- `by_experiment` works without an enabled provider so released database rows
  remain visible in experiment responses when heavy transfer is disabled.

## Change guidance

Keep lifecycle and metadata decisions in `storage.py`; add provider mechanics
only behind `ObjectProvider`. A new byte backend should implement the existing
provider contract and its focused contract tests, not add provider parameters
to `ObjectStorage`. Schema or event changes require migration and release
compatibility coverage. Changes to command text, token behavior, caps,
authorization, or response shapes require MCP and HTTP surface tests.
