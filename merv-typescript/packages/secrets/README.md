# Account Hugging Face access

`@merv/secrets` stores one encrypted Hugging Face token for each verified account
`{issuer, subject}` using State. `@merv/secrets/api` mounts GET, PUT, and DELETE
`/secrets/huggingface`. Only transport-authenticated humans can manage it. All
responses contain `{available, configured, updatedAt}` and use `Cache-Control:
no-store`. PUT accepts `{token}`; no browser or MCP endpoint reads a token back.
The Settings → Session form uses a masked input, clears it on submission, and
never persists it in browser storage.

The deployment environment variable `MERV_SECRETS_ENCRYPTION_KEY` must contain
43 characters: the canonical unpadded base64url encoding of exactly 32 random
bytes. Plugin configuration names the key environment variable through `encryptionKeyEnv`,
whose default is that variable name. Keep the key in the control deployment's protected secret
environment and retain it separately from database backups. Losing or replacing
it makes existing records unreadable; there is no automatic key rotation in v1.
No key is generated or printed by the application. A missing or malformed key
leaves the service running with `available: false`, rejects saves, and supplies no
token to workers. Removal remains available even without the key.

Storage uses jose 6.2.12 compact JWE with direct A256GCM encryption, a fresh random
IV, and a protected authenticated account binding. Moving ciphertext between
accounts or modifying it fails closed. State receives only ciphertext and account
metadata. Decryption errors have a fixed message with no ciphertext or key detail.

## Download broker

Configure `huggingFaceEndpoint` as the deployment's public HTTPS origin plus
`/hf`. The deployment renderer sets this from `MERV_TS_PUBLIC_ORIGIN`. Secrets
mounts a fixed-origin Hugging Face reverse proxy using pinned `httpxy` (no new
service, vault, CA, or database table). It streams responses and leaves cross-host
CDN/Xet downloads direct. Native `huggingface_hub`, `datasets`, `transformers` and
`hf download` use the supplied `HF_ENDPOINT` and `HF_TOKEN` environment variables.
Use a fine-grained **read-only** account token. Model/dataset reads, Xet read
credentials and `paths-info` POSTs are allowed; pushes, account settings, whoami,
Spaces and OAuth are refused. Raw Git authentication is not supported.
The first version also refuses slash-containing revisions, filenames with spaces,
`#`, `?` or `%`, and encoded nested-file redirects in old repos without a namespace.
These fail explicitly; expand the path policy only with native-client evidence.

New managed hosted Codex workers receive a readable, session-bound capability in
`HF_TOKEN`, never the account token. jose encrypts a strict session/allocation/
host/expiry context under an HKDF-derived grant key, separate from storage
ciphertexts. The grant contains no account identity or Hugging Face token.
Sessions owns the single authority callback and rechecks its live lease,
allocation epoch, attached host, source delegation and review policy on every
request using a read-only snapshot. Secrets then resolves the account's current
token and inserts it into the upstream request. No authorization cache is used.

Removal, rotation, session closure and source/allocation revocation apply to the
next request, including on existing connections. Transfers already authorized
may finish; CDN signed URLs and short-lived Xet credentials remain usable until
the upstream service expires them. A capability can be copied by agent code;
redaction does not prevent intentional misuse during its authorized lifetime.
No claim is made that the whole HF service is available or that arbitrary agent
code cannot use the download authority it has been given.

Secrets knows no workflow tables. Sessions supplies identity only after its own
checks. Runner handles private environment delivery/redaction. The Python hosted
assignment launcher admits HF_ENDPOINT only alongside HF_TOKEN, validates its
canonical HTTPS /hf shape, and excludes both from login/Git operations. Its shape
check trusts the supervisor's server-supplied origin; it is not an origin allowlist.
Sealed offline reviews, Pi and local runners get no automatic capability.

For SSH downloads a worker can forward these two variables privately via stdin
to its remote process. Never embed them in tool arguments, saved scripts, artifacts
or managed compute job commands (those commands are persisted). This authority
ends with the worker session; the next worker supplies its own. Durable managed
GPU jobs do not yet receive HF access. Work-bound credentials and Python late
script delivery require a separate change.

The old `/sessions/:id/huggingface` route remains wire-compatible for the hosted
image transition but stops returning raw tokens at **2026-10-08 00:00 UTC**. Remove
its raw-token implementation in the first release after the new image rollout.
New runners use only `/huggingface-access`; errors launch without HF access and
never fall back to raw-token delivery. Existing old processes may retain tokens
issued before rollout; invalidate those at Hugging Face if necessary.

Tests cover authenticated synthetic upstreams, path/header boundaries, range
responses, keep-alive revocation, account rotation/removal, grant expiry and
storage/grant ciphertext separation. Public native HF tests cover model/dataset
snapshots and streaming; a real private/gated repo still requires an account token
entered through Settings and has not been claimed as verified.
