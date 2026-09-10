# Sandbox providers

Merv delegates compute to the independently deployed merv-sandboxes service.
The service's live plugin catalog is authoritative for provider names, fields,
offers, regions, prices, health, and capabilities. Merv contains no provider
SDKs, cloud credentials, provisioning drivers, or machine cleanup workers.

## Connections and policy

The browser's provider settings read the native catalog and connect a complete
credential set to the current project's namespace. Saved secrets stay in the
native vault and are never read back through Merv. Replacing a connection
requires all required fields. Disconnect removes a project-owned connection;
shared host connections are managed by the infrastructure operator.

A shared host provider should use `namespace_prefixes = ["merv-project-"]`
when it is intended only for Merv projects. A standalone namespace's own
connection remains independent, including when it uses the same name.

Existing enabled flags, daily project caps, platform user caps, and spend kill
switches remain Merv policy. Signed admission claims carry that policy and
historical spend to the native service. The service serializes admissions
across projects and reserves the full remaining lease cost. Renewal requires
fresh policy and preserves original payer attribution. Provider credentials
and spend enforcement do not require a Merv VM management process.

## Agent operations

1. Call `sandbox.options` for current providers and hardware choices.
2. Request an offer with a bounded lease and an experiment association.
3. Use the returned SSH certificate/gateway instructions. Keep private keys
   local and refresh expired certificates through the service.
4. Submit durable commands with `sandbox.run`; inspect or cancel them through
   `sandbox.job`. Job IDs uniquely identify runs.
5. Preserve required evidence and outputs, then call `sandbox.release`.

Use the shipped [sandbox-operation skill](../skills/sandbox-operation/SKILL.md)
for the exact sequence. SSH terminal recording from the retired Merv bootstrap
is not available; native job logs and declared outputs are the durable record.
Lease expiry and provider cleanup continue in merv-sandboxes even when Merv is
restarted. Keep outputs in durable storage before release.

## Configuration and migration

Only `MERV_SANDBOXES_URL` and `MERV_SANDBOXES_JWT_SECRET` connect Merv to the
service. Provider keys, SSH certificate-authority material, and object-store
credentials are configured in merv-sandboxes. The retired
`MERV_EXECUTION_BACKEND(S)`, management-key, and S3 configuration variables have
no runtime effect in Merv.

Historical closed sandbox rows remain available for research context and
cost accounting. They expose no reusable SSH connection.
