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
bytes. Plugin configuration contains only `encryptionKeyEnv`, whose default is
that variable name. Keep the key in the control deployment's protected secret
environment and retain it separately from database backups. Losing or replacing
it makes existing records unreadable; there is no automatic key rotation in v1.
No key is generated or printed by the application. A missing or malformed key
leaves the service running with `available: false`, rejects saves, and supplies no
token to workers. Removal remains available even without the key.

Storage uses jose 6.2.12 compact JWE with direct A256GCM encryption, a fresh random
IV, and a protected authenticated account binding. Moving ciphertext between
accounts or modifying it fails closed. State receives only ciphertext and account
metadata. Decryption errors have a fixed message with no ciphertext or key detail.

The internal `resolveHuggingFaceToken({issuer, subject})` capability is only for
Sessions' private managed-worker delivery after authorization of the immutable
source person. Updates and removal apply to subsequent deliveries. Already
running workers retain their environment snapshot; revoke the token at Hugging
Face to invalidate that snapshot. V1 does not propagate to Pi, local runners,
raw SSH hosts, or GPU jobs.
