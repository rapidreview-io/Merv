# Artifacts

## Purpose

Artifacts owns project-scoped immutable content records and their upload
credentials. Consumers own associations, roles, acceptance, and evidence
snapshots. Artifacts never resolves a research target or interprets a workflow.
Physical bytes live behind the `EvidenceBlobStore` port in Merv's own R2 bucket.
Large datasets and models live in merv-sandboxes behind the Infrastructure facade.

## Files and responsibilities

- `artifacts.py`: content creation, bounded uploads, reads, attachment manifests,
  and completeness validation.
- `models.py`: content metadata and upload receipts without consumer-specific
  fields.
- `tools.py`: the `artifact.*` MCP contracts, rendered over the association
  vocabulary (targets, roles) the composition injects.
- `__init__.py`: public content-store interface.
- `r2.py`: boto3-backed put/get/delete, project/digest keys, upload integrity,
  verified downloads, and explicit failure when R2 is not configured.

## Upload lifecycle

1. `submit` reserves a new content ID in a project and records a byte cap and
   whether to discover relative Markdown images. These are technical upload
   options supplied by the caller, not inferred from an artifact's role.
2. The caller receives a random single-use upload credential lasting 15 minutes.
   `pending` resolves it to metadata; `upload_cap` authenticates it before a
   transport reads the body. Display paths are labels, never local file reads.
3. `complete_upload` stores bytes by digest, marks that record complete, and
   consumes its credential. It commits independently unless the caller supplies
   a transaction. A completed upload can subsequently be accepted by a consumer.
4. Resubmission always creates another ID. Completed records, bytes, and
   attachment slots are never replaced in this component.
5. `create` accepts already available trusted bytes and returns a new complete
   artifact. Callers may include its metadata write in their own transaction.
6. `cancel_upload` retires only a pending credential. Callers can coordinate it
   with their own validation without this component knowing their policies.

## Document attachments and immutability

- With `discover_figures`, main-content completion establishes a fixed manifest
  of validated relative Markdown image links. Duplicate links use one slot.
- Each slot receives its own bounded, expiring upload credential. Completion
  writes its digest exactly once. The parent content cannot be re-uploaded.
- Expired attachment slots remain in the manifest with status `expired` and
  no upload token. Expiry therefore cannot turn missing content into a complete
  document. Re-uploading the document creates a new version and fresh slots.
- `assert_complete` requires all selected project artifacts and every manifest
  slot to be complete. Consumers call it in the transaction that pins their
  evidence selection; immutable completed content makes that selection stable.

## Reads and ownership

- `get` preserves first-seen ID order and accepts optional project scope.
  `metadata` avoids byte reads, `content` adds available bytes, and `document`
  also includes completed attachment links and propagates storage failures.
- `figure` reads a completed attachment with optional project scope.
- Database access, transactions, and project existence checks come from Kernel.
  Artifact metadata belongs here; workflow associations and snapshots do not.
- Database transactions serialize one-time completion. Blob writes precede
  metadata commits; orphaned bytes are acceptable after a failed transaction.
- Expired pending content records can be removed. Completed unassociated
  content is retained; retention must account for all consumers before deletion.
- Surface adapters authorize callers. Consumers select upload policies, validate
  accepted content, and record their own audit events and associations.
- R2 configuration requires `MERV_BLOB_BUCKET`, `MERV_BLOB_ENDPOINT_URL`,
  `MERV_BLOB_ACCESS_KEY_ID`, and `MERV_BLOB_SECRET_ACCESS_KEY`; region defaults
  to `auto`, and `MERV_BLOB_PREFIX` optionally prefixes `project/sha256` keys.
  No implicit fallback, cloud bucket creation, or automatic byte expiry occurs.
