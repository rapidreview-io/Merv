# Customer experiments

An opt-in TypeScript mini-product on Merv's existing Pi, Workflows, Sessions, Fleet,
Code, Artifacts, Sandboxes and Reviews services. Each request creates an isolated internal project.
The customer and their coding agent receive request capabilities, never a project key.
Ordinary `experiment` workflows and Pi conversations keep their existing behavior.

```text
customer's agent ⇄ Pi intake (Astra, medium)
                       │
              agreed draft + data requirements
                       │
              private request bucket → content validation
                       │
                   frozen offer
                       │
              customer approves this version
                       │
              Stripe confirms this payment
                       │
          existing Fleet/Sessions/Code execution (Astra, medium)
                       │
              session ends + final code retained
                       │
              independent results review (Astra, medium)
                       │
              private results page + transactional email
```

There is **no design review**. The human accepts the plan agreed with their agent.
`service_experiment@1` has its own graph and owns its contract and payment records.
Execution and review cannot change that contract. A scope change returns to planning
and needs a new accepted and paid contract; repairs stay within the original allowance.
It does not publish a paper, update the main research project, or start reflection waves.

## First offer

The initial price is $10 USD. Intake can discuss broad ideas, but a submitted offer is
bounded by at most 24 worker wall hours, 500,000,000 model tokens and two execution attempts.
These are aggregate contract limits; 20% is reserved for results review. Sessions enforce
per-visit deadlines and Fleet's model relay enforces token budgets. Missing usage accounting
holds further work. Interrupted work can resume within the remaining allowance.

Hardware is an internal execution choice. The intake agent has a read-only tool for the
current Sandboxes CPU/GPU catalog and hourly prices; it cannot rent or enable funding.
The executor selects and rents suitable GPUs through the existing native compute connection.
No GPU type, provider or count is frozen into the customer contract. Catalog availability
is an observation, not a reservation; execution must recheck current capacity and pricing.
Before checkout and payment release, the server links a private Sandboxes namespace to the
request project under the configured sponsor's existing account. Only the explicitly configured
sponsor providers are provisioned there; credentials stay in the Sandboxes vault. Prepaid
provider connections are refused rather than bypassing their entitlement and wallet checks.
The sponsor pays compute costs independently of the $10 customer price.
`MERV_CUSTOMER_COMPUTE_BUDGET_USD` sets the lifetime compute ceiling per request
(unset means no per-request compute cap, independent of the $10 checkout price). The account and payer budgets also apply.
Each request permits one concurrent machine,
and a 24-hour maximum machine lifetime. Existing account/provider rules also apply.
These internal limits do not fix a GPU type. Native capture retention and cleanup remain in Merv.

Data is UTF-8 CSV or JSONL: ten requirements, at most 20 MiB per file, 100 MiB total,
100 columns and 100,000 rows. Validation checks parsing, consistent rows, required columns,
nonempty scalar labels, minimum rows, SHA-256 and byte length. Identical training and
evaluation files are rejected. This does not establish that different files have no
overlapping examples; the agreed method and results review must address that.

A new private S3 bucket is created when a request first needs an upload. Signed PUTs
require an exact digest and an absent object. The accepted manifest freezes bucket,
object key, SHA-256, size, role requirement, validation receipt and artifact reference.
Newer pending replacement uploads prevent submission even if an older file validated.
No shared-bucket fallback is used when bucket provisioning fails.

## Deployment

Disabled by default. Build Main **and the hosted runner image** from this change before
enabling it: older hosted supervisors do not understand the Astra platform selection.
The same model-provider credentials used by Pi and Fleet must have access to
`gpt-6-astra`. Missing Astra capacity never falls back to another model.

The deployment renderer recognizes:

| Setting                                                                                        | Purpose                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `MERV_CUSTOMER_EXPERIMENTS_ENABLED=true`                                                       | Add the plugin; requires Pi and Fleet workflow enabled                                                                  |
| `SANDBOXES_DATABASE_URL`                                                                       | Existing in-process Sandboxes host and integration must be enabled                                                      |
| `MERV_CUSTOMER_COMPUTE_PROJECT_ID`, `MERV_CUSTOMER_COMPUTE_PROVIDERS`                          | Sponsor-owned connected project and JSON array of explicitly allowed provider names                                     |
| `MERV_PI_MODELS`                                                                               | Catalog must include `gpt-6-astra`; the trusted intake role pins medium without changing ordinary conversation defaults |
| `MERV_CUSTOMER_SPONSOR_ISSUER`, `MERV_CUSTOMER_SPONSOR_SUBJECT`                                | Existing verified operator identity that sponsors isolated projects; must be in `MERV_FLEET_WORKFLOW_PEOPLE`            |
| `MERV_CUSTOMER_INTAKE_KEY`                                                                     | Random invitation bearer, at least 32 bytes; controls alpha intake access                                               |
| `MERV_CUSTOMER_ACCESS_KEY`                                                                     | Separate random server key, at least 32 bytes; signs request capabilities                                               |
| `MERV_CUSTOMER_REQUESTS_PER_DAY`                                                               | Optional deployment-wide new-request cap, default 25                                                                    |
| `MERV_CUSTOMER_DATA_ENDPOINT`, `MERV_CUSTOMER_DATA_REGION`, `MERV_CUSTOMER_DATA_BUCKET_PREFIX` | Dedicated S3 endpoint, region and bucket naming prefix                                                                  |
| `MERV_CUSTOMER_DATA_ACCESS_KEY_ID`, `MERV_CUSTOMER_DATA_SECRET_ACCESS_KEY`                     | Server storage credentials                                                                                              |
| `MERV_CUSTOMER_STRIPE_SECRET_KEY`, `MERV_CUSTOMER_STRIPE_WEBHOOK_SECRET`                       | Stripe test keys initially                                                                                              |
| `MERV_CUSTOMER_STRIPE_LIVE=true`                                                               | Explicit live-mode opt-in; requires email configuration                                                                 |
| `MERV_CUSTOMER_RESEND_KEY`, `MERV_CUSTOMER_EMAIL_FROM`                                         | Transactional results sender and verified sending address                                                               |

Storage credentials need permission to create buckets, block public access, set CORS,
and put/head/get objects under this feature's bucket prefix. The backend must implement
S3 `CreateBucket`, `PutBucketCors`, conditional PUT and SHA-256 checksums. AWS S3 also
uses `PutPublicAccessBlock`; Cloudflare R2 uses its private-by-default buckets and no public domain. Buckets are retained; no automatic
deletion policy is installed by this module.

The feature can run intake without Stripe. Checkout then stays unavailable and no
execution is released. Missing storage blocks requests that require uploads. For a live
launch, configure and verify the provider integrations in staging first.

Register the Stripe webhook at:

```text
https://YOUR_MERV_ORIGIN/customer-experiments/stripe-webhook
```

Subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
The adapter verifies the raw body signature, payment mode, paid status, contract hash,
request and amount. The success redirect never fulfills an order. Provider calls use
idempotency keys, and signed webhook replays cannot release execution twice. Stale
contracts and mismatched payments are refused for operator investigation. Automatic
refunds are not implemented.

For direct plugin composition use `@merv/customer-experiments` with `publicOrigin`,
`sponsor: {issuer, subject}`, `computeProjectId`, `computeProviders`, and optional
`storage`, `stripe` and `email` (see `index.ts`). The existing Sandboxes host owns credentials,
account policy, machines, jobs and evidence; this adapter provisions request scope only.
Enable `astraMediumEnabled: true` on `@merv/fleet/workflow` and automatic Sessions dispatch.
Do not put secret values in config; the plugin accepts environment variable names.

## Prompt and API handshake

The alpha invitation belongs in the customer's agent environment, not a checked-in prompt.
The supplied prompt can be:

> Talk to Merv at MERV_ORIGIN using my experiment invitation in MERV_EXPERIMENT_INVITE.
> Create a request with a fresh cryptographically random UUIDv4 requestId; keep it private
> for retries. Describe the experiment I want to run. Answer Merv's interviewer from this
> repository and relevant research, and bring unresolved decisions back to me. Do not
> approve or pay for me. When the plan is ready, show me the returned customerUrl so I can
> check the fixed plan, upload any required files, and submit it.

1. `POST /customer-experiments/requests`, invitation bearer, JSON
   `{requestId, title, message?}`. Returns `{id, agentToken, customerUrl, apiUrl, expiresAt}`.
   Retrying the same private UUID and title recovers the same request and capabilities.
2. `POST {apiUrl}/messages`, agent bearer, `{commandId, text}`. Keep `commandId` stable on retry.
3. `GET {apiUrl}`, agent bearer, polls the transcript, draft, data readiness and workflow.
4. Give the human `customerUrl`. Its fragment capability stays out of HTTP URLs and is
   exchanged locally for an Authorization header; the page strips it from the address bar.
   Agent access expires after 30 days; customer monitoring links remain available.
   Possessing the customer link permits approval, so agents
   must follow the instruction to hand it to the human.

The customer page handles upload begin, signed transfer, validation, exact-version
acceptance, Stripe checkout, status and authenticated result downloads. Worker tools
are separate: `customer_experiment.get` and `customer_experiment.submit_results`, plus
the existing artifacts, Code and Reviews tools granted by the workflow. From
`service_experiment@4` the running worker also posts status-page lines with
`customer_experiment.progress`; a session calls only what its version's policy grants.
Merv's own agents (the worker, its reviewer through `review.submit`, the interviewer and
the healer) read the request without the buyer's email and payment id; the customer page,
the owner and the platform administrator keep them.

Every ten seconds the module reconciles final code captures and result email delivery.
Remote result files must be retained as native Capture artifact collections before handoff;
the review and final delivery use the frozen retained evidence for that compute attempt.
On restart it reads durable request, contract, payment and workflow records. Pi profiles
and file-provider registrations withdraw on unload; work fails closed until the matching
owners are back. Rotating the access signing key invalidates all outstanding links.

## Validation

```sh
npm run typecheck
npm run build
MERV_TEST_POSTGRES_URL='postgresql:///YOUR_TEST_DB?host=/tmp' \
  node --import tsx --test tests/customer-experiments-*.test.ts \
  tests/pi-profiles.test.ts tests/sessions-execution-limits.test.ts
node --test deploy/render-config.test.mjs
```

Tests use isolated PostgreSQL schemas, the actual workflow/session/Code/review machinery,
and local fixtures for paid events, data storage and hosted inference. They do not charge
cards, rent machines, create cloud buckets or send emails. Page tests cover credential
handling, upload validation, stale approval, checkout and private downloads; desktop and
mobile rendering has also been checked in Chromium.
