# Artifact bytes on S3 or R2

The existing Blobs plugin supports asynchronous disk and S3-compatible storage. It still has no State dependency. Artifacts owns metadata and permissions; Blobs stores immutable bytes under a project namespace and SHA-256 content hash. Ordinary uploads and inline reads remain limited to 2,000,000 bytes. Artifacts imported from the legacy system up to 512 MiB are downloaded directly; heavy sandbox outputs remain in the external storage system.

Existing local configuration is unchanged:

```json
{ "root": "/var/lib/merv/blobs" }
```

For S3 or R2, select:

```json
{ "backend": "s3" }
```

The default environment variables match the previous Python backend:

| Variable                      | Meaning                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `MERV_BLOB_BUCKET`            | Existing artifact bucket                                           |
| `MERV_BLOB_ENDPOINT_URL`      | HTTPS origin, without credentials, path, query or fragment         |
| `MERV_BLOB_ACCESS_KEY_ID`     | Storage access key                                                 |
| `MERV_BLOB_SECRET_ACCESS_KEY` | Storage secret key                                                 |
| `MERV_BLOB_REGION`            | Optional; defaults to `auto` for R2; set the actual region for AWS |
| `MERV_BLOB_PREFIX`            | Optional object prefix, with no empty, `.` or `..` path segments   |

The first four are required. Partial configuration fails before publishing the provider. The plugin never falls back to disk or the ambient AWS credential chain. Configuration may override environment variable **names** through `bucketEnv`, `endpointEnv`, `accessKeyIdEnv`, `secretAccessKeyEnv`, `regionEnv` and `prefixEnv`; it does not accept literal credentials. Provider errors returned to callers omit SDK response details and credentials.

S3 keys preserve the Python format: `prefix/project/sha256`, omitting the prefix when empty. Disk keeps its existing `root/project/first-two-hash-characters/sha256` layout. Switching providers does not migrate existing bytes or metadata automatically.

Uploads use a signed conditional write (`If-None-Match: *`) and Content-MD5 for transfer integrity. An existing object is fetched and SHA-256 verified before a duplicate upload succeeds. Downloads enforce the size limit while streaming and verify the complete hash. Corrupt content is rejected, never overwritten. The plugin creates no buckets, deletion schedules or lifecycle policies and exposes no deletion method.

`timeoutMs` bounds each complete remote operation, including response-body consumption and request retries (default 30,000; maximum 120,000). `maxAttempts` defaults to 3 and is limited to 1–5. Retry backoff observes the same deadline. During unload, the provider stops accepting calls, drains admitted operations and then destroys the SDK client. Production endpoints require HTTPS. The direct provider constructor has an explicit HTTP-loopback allowance only for protocol tests; plugin configuration cannot enable it.

Both providers expose Promise-returning `put` and `get`. Disk retains atomic create-without-replacement, flushed file writes and integrity verification. Callers must await durable storage before publishing successful artifact metadata. Blobs does not make database and object storage one atomic transaction; database failures after a successful upload may leave unreferenced content, and callers must not delete a shared hash on rollback.

`tests/blobs-s3.test.ts` exercises the real AWS SDK against a local HTTP fixture: SigV4 headers, conditional writes, verified duplicate content, corruption, bounded reads, sanitized failures, retry limits, deadlines and drain behavior. It also checks asynchronous disk immutability and cleanup. These tests use fake credentials and do not prove access to a real deployment bucket.

## Large retained artifacts

`artifact.get` includes `downloadAvailable` without changing the immutable metadata record. On S3/R2, `artifact.read` accepts optional `mode: "download"` and returns the artifact plus `{ url, expiresAt }`. The artifact service checks live project access before and after preparing the URL; agents cannot supply object keys, buckets or project namespaces. Disk explicitly reports that direct downloads are unsupported.

The URL grants GET access to one exact object for 60 seconds. Its signed response overrides force `attachment`, `application/octet-stream` and `private, no-store`. The UI prepares it only when clicked, removes expired links and offers refresh. The browser downloads directly from storage, so large bytes never enter the API JSON response or agent context. **A URL already issued remains usable for up to 60 seconds after access is revoked.** Revocation blocks fresh URLs and a request whose storage preparation is still pending. Do not log or persist these bearer URLs. The immutable SHA-256 remains in artifact metadata; the direct download does not rehash hundreds of megabytes before every URL is issued.

Artifacts over the inline limit exist only because the one-time [legacy import](LEGACY_IMPORT.md) copied them; that importer and its verified server-side copy were removed on 2026-09-23. A download checks the exact HEAD length against the retained size (at most 512 MiB) before signing, within the ordinary operation deadline.

The local protocol tests verify presigned query signatures, downloaded attachment/cache headers, project-path tampering, size mismatches and authorization during revocation, seeding large objects directly into the S3 fixture.

Completed legacy zero-byte files are retained with their original IDs and the SHA-256 of empty bytes. Direct download accepts HEAD length 0; native artifact.create still requires nonempty content.
