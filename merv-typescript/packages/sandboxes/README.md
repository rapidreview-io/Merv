# Sandboxes

Merv loads the pinned Sandboxes packages in-process through `@merv/sandboxes/host`.
The [host contract](../../vendor/merv-sandboxes/typescript/hosts/merv/README.md) defines
the shared database, migration guard and service capabilities. Standalone owns workers,
gateway, API/MCP and console; Merv never migrates the Sandboxes database.

`@merv/sandboxes/integration` attaches scoped connections to leased workflow sessions,
retires runs and attempts, and projects capture evidence into Merv artifacts. Tasks and
Experiments consume `sandboxEvidence`. Fleet owns runtime profiles and rental handles;
Code Work owns its check recipe.

The integration also loads `merv-sandboxes-people` (`sandboxesPeople`, `people.ts`): every verified
person gets their own Sandboxes person, account and admin membership through Sandboxes' persons,
at first sign-in (Scope's `members.onFirstSignIn`) and, at start, for everyone signed in before.
`newPersonCredits` (`MERV_NEW_PERSON_CREDITS`, e.g. `{"lambda":"10"}`) grants each account USD once
per provider under `welcome:<provider>:<digest>`; a provider no operator connection serves is
skipped and logged once.

Each Capture node registers as its own collection: a succeeded one once it ends, while the
rest of its workflow may still run, and any other once its workflow finishes, because cleanup
may still recover its files. Its title starts `Compute capture <workflow id> / <node id>` and
says when the node failed, was skipped or kept nothing; `metadata.outputObjects` names
its held output objects, which a later workflow of the project stages directly. A
deterministic refusal is final. A failure that may pass is retried every pass, and after
ten minutes it is also listed as refused, marked `retrying`, until it registers.

`@merv/sandboxes/console` mounts the authenticated console-session endpoint, proxies
`/sbx/ui/*` and `/sbx/v1/*` (including Terminal WebSockets), and contributes hardware to
Running. The host registers the permanent Sandboxes view and tools.

The deployment renderer loads all three entries, using `SANDBOXES_DATABASE_URL`,
`SANDBOXES_VAULT_KEY`, shared `/data` and `MERV_SANDBOXES_PROXY_URL`. Project links and payer authority
are checked through the host's live services. Fleet profiles come from `MERV_FLEET_RUNTIMES`.

Historical `sandboxes-native` and `sandboxes` artifact providers share one direct downloader.
It checks the retained owner and object digest/size without rewriting immutable manifests.
The native ownership tables remain read-only history; their migrations are retired.
`legacyCaptures.namespace: 'merv-ml'` locates the six retained bare-object references.

Focused coverage lives in `sandboxes-host.test.ts`, `sandboxes-people.test.ts`, `sandbox-runs.test.ts`,
`sandbox-evidence.test.ts`, `sandboxes-historical-evidence.test.ts`,
`ui-sandboxes-host.test.ts` and `ui-sandboxes-server.test.ts` under `tests/`.
