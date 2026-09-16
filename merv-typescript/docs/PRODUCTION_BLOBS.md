# Artifact bytes on S3 or R2

The existing Blobs plugin supports asynchronous disk and S3-compatible storage. It still has no State dependency. Artifacts owns metadata and permissions; Blobs stores immutable bytes under a project namespace and SHA-256 content hash. Ordinary uploads and inline reads remain limited to 2,000,000 bytes. Verified legacy artifacts up to 512 MiB can be imported and downloaded directly; heavy sandbox outputs remain in the external storage system.

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

The trusted offline importer can use `destination.copyVerifiedFrom(source, projectId, hash, size)`. Both stores must use the same S3 endpoint; destination credentials also need permission to read the source object. Keys derive solely from each configured prefix, project and retained hash. If retained metadata has no size, the offline caller may omit size; HEAD then supplies a nonnegative size within the same 512 MiB bound. A provided size must match exactly. The method checks HEAD length and ETag, streams the source SHA-256 under `If-Match`, copies only that source version without replacing a destination, then checks destination HEAD length and its full streamed SHA-256. A 412 response succeeds only if the entire destination is verified. Source corruption or a changed source with no verified destination fails the import.

AWS uses `If-None-Match: *` on CopyObject; R2 endpoints use its signed `cf-copy-destination-if-none-match: *` extension. R2 documents that source and destination conditions are checked at different phases, so destination verification is required even after a successful copy. See [AWS CopyObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html) and [R2 conditional destination operations](https://developers.cloudflare.com/r2/api/s3/extensions/#conditional-operations-in-copyobject-for-the-destination-object).

Each transfer is capped at 512 MiB, hashes streamed chunks without collecting a whole file, and runs within one deadline (120 seconds by default; an offline caller may select at most 900 seconds). The foundation importer transfers one distinct project/hash at a time, outside the database writer, and writes all metadata with its immutable receipt only after successful verification. Provider unload drains the admitted transfer on both source and destination. No deletion, bucket creation, arbitrary-URL fetch or public copy tool is added.

The local protocol tests also verify presigned query signatures, downloaded attachment/cache headers, project-path tampering, source-change races, corrupt 412 destinations, large import replay, authorization during revocation and transfer drain. A real deployment must still verify its bucket permissions and supported copy conditions before importing source data.

Completed legacy zero-byte files are retained with their original IDs and verified SHA-256 of empty bytes. Offline copy and direct download accept HEAD length 0; native artifact.create still requires nonempty content.
