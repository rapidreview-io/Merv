# Customer experiments v3: customer page, chat, plan, files

Status: building (2026-10-14). Applies to new requests only: `service_experiment@3`.
Requests on v1/v2 keep their current behaviour and page; nothing pinned changes.

## Rule: reuse, don't rebuild

- **Chat is the existing Pi intake conversation.** The request already owns one Pi
  conversation (profile `customer-experiments-intake`, created by the sponsor caller in
  `service.ts`). The customer reaches *that* conversation through a narrow adapter in
  customer-experiments that calls the existing `PiService` (`snapshot`, `send`, `stop`) and
  the existing Pi event stream as the sponsor caller. No second chat model, store or
  protocol. `@merv/pi` only gains a small exported seam so another plugin can serve the
  stream it already serves at `/pi/<id>/events`.
- **Chat UI is the existing Pi UI.** `packages/ui/web/views/pi.tsx` (`Transcript`,
  `Composer`) and `pi-conversation.ts` (`useConversation`) gain a transport seam (how to
  snapshot, send, stop and open the event stream). The main app passes today's transport
  unchanged; the customer page passes one pointing at the adapter routes. Features the
  customer must not have (model picker, machine, proposals, record links, voice) are turned
  off by props/absence, not forked.
- **Storage is the existing per-request bucket** (`RequestBuckets` in `data.ts`, S3 API, R2
  in production), extended with multipart presigning, listing, rename, delete and expiry.
- **Contract, acceptance, Stripe checkout and results** are the existing domain flow; v3
  changes what the plan is and who verifies it, not how money or execution work.
- **File manager UI** ports the braziliano bucket UI
  (`merv-sandboxes/deploy/r2-upload/src/page.html`) into React: same look and behaviour
  (breadcrumbs, folders with sizes, upload with progress, rename, delete, download).
- UI copy rule: no helper or side text on these screens. Verbose copy only on money and
  destructive actions (payment, delete, the 48-hour deletion notice).

## Identity: capability link + Supabase anonymous user (no email)

CHANGED 2026-10-14 (user): no emailing at all. Same pattern as Nisa
(`Nisa/project/frontend/src/contexts/AuthContext.jsx`: when there is no Supabase session the page
calls `supabase.auth.signInAnonymously()`; same Supabase project, anonymous sign-ins already on).

- The link the agent gives the customer keeps its capability token in the URL fragment
  (unchanged). It alone no longer acts as the customer.
- The page creates/keeps an anonymous Supabase session automatically (persisted in
  localStorage so the same browser stays the same person). No sign-in screen, no OTP.
  Supabase config comes from the identity plugin (`identity.configuration().login`).
- `@merv/identity`: `verify()` keeps refusing anonymous users by default; add an explicit
  opt-in (e.g. `verify(token, { allowAnonymous: true })`) returning `anonymous: true`, used
  only by customer-experiments. Read `is_anonymous` from the JWT claims.
- First `POST /session` **binds** the request to that identity (issuer, subject). Afterwards
  that identity plus the capability acts as the customer. Opening the link in another
  browser shows "Open here instead"; confirming calls `POST /session {takeOver:true}`, which
  rebinds to the new identity (capability required) and the old browser loses customer
  access. Stored in customer-experiments' own table (new migration).
- Every customer-role call carries both: `Authorization: Bearer <capability>` and
  `X-Merv-Identity: <supabase access token>`. The `agent` capability (the customer's coding
  agent) stays capability-only and keeps its current routes; it never gets chat-as-customer,
  plan edit, files write or payment.
- Email: none collected by the page. v3 checkout sends no email field; Stripe Checkout
  collects it, and results delivery uses the email from the Stripe webhook
  (`customer_details.email`).

## HTTP API (all under `/customer-experiments/requests/:id`)

Customer role = capability + bound identity unless noted.

| Route | Who | Purpose |
|---|---|---|
| `GET /session` | capability only | `{ version, bound, login: { url, publishableKey } }` |
| `POST /session` `{takeOver?}` | capability + identity | bind on first call; mismatch → 409 `bound_elsewhere` unless takeOver |
| `GET /` | agent or customer | existing snapshot, plus v3 fields below |
| `GET /chat` | customer | Pi snapshot of the intake conversation, sponsor-only fields removed |
| `POST /chat/messages` `{commandId,text}` | customer | `PiService.send` |
| `POST /chat/stop` | customer | `PiService.stop` (if Pi exposes it; else omit) |
| `GET /chat/events` | customer | the same SSE stream `/pi/<id>/events` serves |
| `GET /plan` | agent or customer | plan view (below) |
| `PUT /plan` `{expectedRevision, document}` | customer | edit while `drafting` or `changes_requested` |
| `POST /plan/submit` `{expectedRevision}` | customer | → `verifying`; posts a turn to the intake agent |
| `POST /checkout` `{contractVersion}` | customer | v3: accept + Stripe checkout in one step, $10 |
| `GET /files?prefix=&cursor=` | customer or agent | `{ folders:[{prefix,size,count}], files:[{key,size,uploaded}], cursor, totalBytes, limitBytes, deleteAt, deletionPolicy }` |
| `POST /files/uploads` `{key,size,contentType}` | customer | multipart create; `{ uploadId, partSize, parts:[{partNumber,url}] }` (presigned PUT, browser → bucket directly) |
| `POST /files/uploads/:uploadId/parts` `{key, partNumbers}` | customer | more presigned part URLs (resume) |
| `POST /files/uploads/:uploadId/complete` `{key, parts:[{partNumber,etag}]}` | customer | complete |
| `DELETE /files/uploads/:uploadId?key=` | customer | abort |
| `POST /files/rename` `{from,to}` | customer | copy + delete (folders: every object under the prefix) |
| `DELETE /files?key=` or `?prefix=` | customer | delete file or folder |
| `GET /files/download?key=` | customer or agent | `{ url }` short-lived presigned GET |

Files rules: any file type; keys are normalised relative paths (no `..`, no leading `/`,
≤ 1024 bytes); total per request ≤ 1 TB (enforced at upload create against listed size +
declared size); part size chosen so a 1 TB object fits in 10,000 parts. Bucket CORS must
allow `PUT` with `ETag` exposed for the page origin. Files edits are refused once the
contract is accepted (the manifest is frozen into it), and after deletion.

## Plan (v3)

- The plan is **one free-text Markdown document** with revisions. Both sides edit it: the
  customer in the page, the intake agent with tools. Optimistic concurrency via
  `expectedRevision`. Statuses: `drafting` → `verifying` → `changes_requested` | `accepted`.
- `GET /plan` → `{ revision, document, updatedBy: 'customer'|'agent', updatedAt, status,
  feedback, contract: null | { version, priceCents, currency, limits } }`.
- The agent signals "plan ready" by writing the document; the page shows the Plan nav dot
  once the document is non-empty.
- `POST /plan/submit` sets `verifying` and sends a turn into the intake conversation
  ("The customer submitted plan revision N for verification"). The **same intake agent**
  verifies: resources fit the limits (24 worker hours, 500M tokens, 2 attempts), scope is
  executable, the files it needs are present. It calls:
  - `customer_experiments.plan_read` / `customer_experiments.plan_write
    {expectedRevision, document}` (agent edits while drafting), and
  - `customer_experiments.plan_verify { revision, decision: 'accept'|'changes_requested',
    feedback, question, criteria[], limits{wallMinutes,maxTokens,maxAttempts} }`.
  `changes_requested` returns the plan to the customer with the feedback shown in chat and
  on the plan. `accept` freezes the contract: document + revision + the structured summary
  (question, criteria, limits) + the file manifest (keys, sizes, etags) + price $10, and
  moves the workflow to `ready`.
- Structure is relaxed: only `question`, `criteria` and `limits` are structured, filled by
  the agent at verification. Report prefill (`report-subject.ts`) uses those and the
  document; execution reads the document as its specification.
- Payment: `POST /checkout` on the accepted contract → existing Stripe flow; price is part
  of the contract (`amountCents: 1000`).

## Data deletion

- Files are deleted **48 hours after the experiment ends**: `complete`, `failed`, or
  abandoned (no plan accepted and no customer activity for 7 days). `deleteAt` is set when
  that happens and shown on the files screen; before that the screen shows the policy
  ("Deleted 48 hours after the experiment ends").
- A sweeper in customer-experiments deletes every object and the bucket at `deleteAt` and
  records it; the page then shows the files as deleted. Results artifacts are not request
  files and are not deleted.

## Pages (packages/ui, second Vite entry `customer`)

Served at `/customer-experiments/r/:id` for v3 requests (v1/v2 keep `customer-page.ts`).

1. **Arrive** — header "Merv | Experiment". Anonymous session created silently. A drop
   zone ("Drop datasets, papers, context") with the request's current size chip that opens
   the file manager; the chat below it.
2. **Chat** — scrolling down makes the chat full screen; header gains "Files" and
   "Plan" (dot when a plan exists). Chat = reused Pi `Transcript` + `Composer`.
3. **Plan** — editable Markdown document (read-only while verifying/accepted), status,
   agent feedback, Submit; a docked chat panel; after acceptance "Pay $10" → Stripe.
4. **Files** — the braziliano file manager, plus the deletion notice.
