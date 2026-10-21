# Isolated native staging Sandboxes

This replaces the draft from 4273404e. The executable operator sequence and input contracts are in
[staging-isolation/README.md](staging-isolation/README.md). Parent alone executes live operations,
after independent review. Existing workflow/task/history/admission preservation, boot maintenance,
customer ingress fence and paused recovery timers remain prerequisites. Never restart old Main or
runner after the committed task migration.

Use the existing staging VM/Postgres with a dedicated sandboxes_staging DB/login, fresh private
staging-native data volume/vault/CA, compatible pinned controller and an actual SSH gateway.
The only provider apps are a03c1f13-92c1-46c7-a246-17c9304c0f21 and
a03d8ea0-6914-4a7c-9f45-08e25da4a6ab. Select only their two existing bridge secrets over private
operator channels. No whole production env, vault, gateway keys, account balance or account dump.

Preserve all 75 stopped instances and exact Fleet IDs with the original 32/43 per-project ownership,
14 closed work rows, six captures, retained connection and all 15 native file references across five
namespaces. The selective exporter follows actual FK and logical reference closure, validates source
objects, downloads/hash-checks bytes, and records original provenance. Import binds the independently
reviewed export digest, preserves IDs, archives imported account/member authority, rejects active
credentials and keeps historical namespaces UNLINKED. Stopped histories stay on source too. Original
artifact references remain unchanged; internal target object locators use an organizational prefix in a dedicated staging-only bucket
with a durable bucket-scoped key; source/customer bucket access must be denied.
Readable encrypted Kopia repositories require explicit selected-repository rekey proof; no successful
import may silently claim they work under a different vault.

Fresh native namespaces link the two existing staging projects through the supported non-login
operator bootstrap. This creates no human identity or bearer. Both provider allowlists and runtime
launch grants name only these new namespaces. Bounded account limits are one concurrent allocation,
900 seconds, $1/hour ceiling and $5 all-time Cloudflare cap per account, subject to parent review.
Do not attach the mixed-project legacy namespace wholesale to the Pi host project or copy balances.

Use the separate complete HTTPS origin https://dev-experiments.rapidreview.io:8443, subject to actual
TLS/firewall verification, for native /mcp, /agent, UI/API and standalone auth. Main callbacks retain
https://dev-experiments.rapidreview.io. The /sbx UI/API proxy is insufficient. The renderer now accepts
an explicit origin and rejects production origin for staging; a reviewed forward Main image is
required because current e9 cannot honor the new setting. Keep boot maintenance throughout setup.
The real staging SSH gateway shares only staging /data and its private authenticated controller route;
verify public port 2222 and fresh host/CA fingerprints before bootstrap.

Register isolated merv-relay offline at an explicit observed event boundary before new links/events.
The initializer uses the pinned definition and event append lock without starting a delivery worker.
Never copy production's cursor or temporarily lift maintenance to initialize one.

The durable handoff reserves both deployment owners. Source first persists a namespace-scoped
Cloudflare billing denial under the native account lock, so stale readers cannot admit staging work.
It then verifies full native emptiness, preserves originals/intent, removes only staging providers and
catalog entries from both source readers on their exact images, installs the temporary Pi admission barrier and waits for natural completion and idle expiry
before each recreation, then verifies source denial/inventory before writing relinquishment. Destination
requires that exact receipt before enabling its controller. Interrupted phases resume forward from
the same immutable plan. No production app rollout or customer balance/namespace rewrite is allowed.

Hosted release --staging-cutover --isolated-staging uses production only for accepted immutable
provenance. Staging owns catalog, census, native inventory, images and durable run state. Prepared
receipts bind the isolated identity and exact runner/Main/controller images. An idempotent canary
intent preserves unfinished attempts on retry; terminal failures rotate only after verified release
and full native census. It waits for natural idle expiry and never stops the shared Pi machine. Later accepted ordinary production runners use the same explicit staging path. Later reader
images use the prepare/accept reader-binding tool around the normal reviewed forward image release,
not manual receipt edits or relaxed identity checks.

Before opening ingress, require real authenticated historical downloads with digest/length checks and
wrong-project denials, real Pi smoke through the staging gateway/callbacks, provider observed stop and
both app inventories, and exact fenced preservation checks. Restore ingress and the two prior recovery
timers only after independent evidence acceptance. Local tests and root-private preparation do not
constitute live acceptance. The operator runbook names all concrete inputs still to collect.
