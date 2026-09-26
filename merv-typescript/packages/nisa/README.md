# Nisa

Nisa gives every agent RapidReview's literature search: keyword and semantic
search over Nisa's arXiv index, one paper's record, the passages inside its
full text, and similar papers. It calls Nisa's public `/api/sdk` routes, the
ones the `nisa` CLI uses, with one deployment-wide `rr_sk_` key, and needs
nothing deployed on Nisa's side. It is optional and dormant: the deployment
composes it only where the key is configured (see
[Turning it on](#turning-it-on)).

| Entrypoint         | Requires    | Provides                                 |
| ------------------ | ----------- | ---------------------------------------- |
| `@merv/nisa`       | nothing     | `nisa` service                           |
| `@merv/nisa/tools` | Nisa, Tools | the five `nisa.*` tools below, all reads |

## Tools

Every tool is a read (`readOnly`) of another service (`openWorld`): the
registry runs it without holding a PostgreSQL snapshot while Nisa answers, and
checks the caller again before handing back the result. None names a
`conversation` use, so:

- **Pi** offers them to every turn, a reader's too, as `nisa_search`,
  `nisa_semantic_search`, `nisa_paper`, `nisa_excerpts` and `nisa_related`, and
  runs them as the person;
- **leased workers** may call them as open reads their policy never names:
  Claude workers through `mcp__merv`, Codex workers because the five names are
  in the runner's fixed project reads (every Codex worker, sealed reviews
  included: a call reaches Nisa alone, never an address the worker chooses,
  though its query leaves Merv; see [Privacy](#privacy)). Every Codex and
  Claude launch's text names them for literature, and names `web.search` too
  where that launch is given it, since a worker otherwise reads its tools as
  project reads and answers from memory;
- **MCP clients** list them with `readOnlyHint` and `openWorldHint` set.

| Tool                   | Nisa route                                 | Input                                                                                           |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `nisa.search`          | `POST /api/sdk/search`                     | `query` (1-8 phrasings), `max_results` 1-20, `offset` 0-500, `author`, `date_from`, `date_to`   |
| `nisa.semantic_search` | `POST /api/sdk/semantic_search`            | `query` (1-4 paraphrases), `max_results` 1-20, `offset` 0-200, `author`, `year_min`, `year_max` |
| `nisa.paper`           | `GET /api/sdk/paper/{id}`                  | `arxiv_id`                                                                                      |
| `nisa.excerpts`        | `GET /api/sdk/paper/{id}/excerpts?q=&max=` | `arxiv_id`, `query`, `max_excerpts` 1-20                                                        |
| `nisa.related`         | `GET /api/sdk/paper/{id}/related?n=`       | `arxiv_id`, `max_results` 1-20                                                                  |

Input is checked here, more strictly than Nisa checks it, since Nisa silently
resets a bad `max_results` or `offset`: each phrasing is 1-1,000 characters,
`author` at most 200, a date is `YYYY`, `YYYY-MM` or a real `YYYY-MM-DD` and
`date_from` is not after `date_to`, and unknown keys are refused. Nisa reads
`author` differently in the two searches, and each tool's schema says how:
keyword search matches whole name words, all of them (`Yann LeCun`), with
commas separating alternative authors (`Vaswani, Hinton`); semantic search
matches a substring of the author list. An arXiv ID
may carry an `arxiv:` prefix or a version, both dropped; an old-style ID
(`hep-th/9901001`) reaches Nisa's routes as `hep-th_9901001`, the form its
index keys, and comes back with its slash. Keyword search always sends
`enrich: false`, so it never starts one of Nisa's research agents, and the
`User-Agent` is `merv-nisa/0.1.0` (never `python-httpx/`, which Nisa still reads
as its old SDK asking for enrichment).

Every paper, from any tool, has only these fields, whatever Nisa sent:

```json
{
  "identifier": "arxiv:1706.03762",
  "arxiv_id": "1706.03762",
  "url": "https://arxiv.org/abs/1706.03762",
  "title": "Attention Is All You Need",
  "authors": ["Ashish Vaswani", "Noam Shazeer"],
  "year": 2017,
  "citation_count": 123456,
  "score": 12.346,
  "snippets": ["multi-head attention"]
}
```

`identifier`, `title`, `authors`, `year` and `url` are what `paper.cite`
takes. A list names at most 12 authors a paper, with `more_authors` saying how
many are left out, and cuts a title at 300 characters; `nisa.paper` names up to
100, `paper.cite`'s limit, and the descriptions say to read it before citing a
paper whose list entry is cut. A generational suffix Nisa writes after a comma
(`Henry E. Kyburg, Jr.`) stays with its author. A year Nisa leaves out is read
from the arXiv ID, as Nisa's own data loader reads it: its paper route gives
none for an old-style ID. `score`
is BM25 for keyword search, similarity for semantic and related search, and
null for a record. Keyword results carry up to three snippets; semantic and
related results carry the start of the abstract instead; `nisa.paper` adds the
whole abstract (to 10,000 characters) and `categories`. A list answer adds
`count`, `offset`, `truncated` and `next_offset` (where the next page starts),
and `index_latest_pub_month` when Nisa reports how recent its keyword index is.
Nisa pages keyword search no further than offset 500 and semantic search no
further than 200; a next page past that has no `next_offset`, and its `note`
says to narrow the query instead.
Nisa's `pagination_hint`, `clamp_note`, `why`, `cluster`, `pagerank`, and any
field not named here, never pass.

Every answer is sized to what Pi shows the model of one result (32,000 bytes of
JSON): passages and abstracts are shortened first, with a `note` saying so,
then a page ends sooner. Descriptions tell a model to use these tools, not a
web search, for literature, name `paper.cite` (a passage from `nisa.excerpts`
is cited with the record `nisa.paper` returns), say that paper text is
untrusted source material, and say what leaves Merv.

## Failures

Nisa is asked once: its own routes retry its index. Each call has a deadline
over headers and body (40 s for a search, 15 s otherwise), follows no redirect,
reads at most 2 MiB of JSON, and refuses a success that carries an `error`.
Errors say at most an HTTP status, never what Nisa wrote:

| Code                                                                      | Status | Meaning                                                  |
| ------------------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| `invalid_input`                                                           | 400    | Refused here, before any request                         |
| `nisa_request_refused`                                                    | 422    | Nisa refused the request (HTTP 400)                      |
| `nisa_not_found`                                                          | 404    | `nisa.paper`: no such paper; `nisa.excerpts`: no text    |
| `nisa_no_related`                                                         | 404    | `nisa.related`: no similar-paper data for this paper     |
| `nisa_key_refused`                                                        | 503    | Nisa refused the deployment's key (HTTP 401 or 403)      |
| `nisa_rate_limited`, `nisa_busy`                                          | 429    | Nisa is limiting requests, or Merv's calls are all taken |
| `nisa_index_unavailable`                                                  | 503    | `nisa.excerpts`: Nisa's passage index is down (503, 504) |
| `nisa_timeout`                                                            | 504    | The deadline passed                                      |
| `nisa_upstream_error`, `nisa_invalid_response`, `nisa_response_too_large` | 502    | Anything else Nisa did                                   |
| `nisa_unavailable`, `nisa_stopped`                                        | 503    | No key, or the plugin is unloading                       |

A refused key is never 401 or 403, which a transport would take for the
caller's own. Only Nisa's passage route answers 503 or 504: when its keyword
index, or semantic search's embeddings or vectors, are down, Nisa answers 500,
which is `nisa_upstream_error` "Nisa failed (HTTP 500); try again later". A 404
means what its route lacks, never that a search route is missing (that is
`nisa_upstream_error` too). Nisa's similar-paper data covers only part of the
papers it holds (about 531,000 of 2.7 million in a local snapshot), none with
an old-style ID, and none added since it was last built: `nisa_no_related`
says so, so an agent never takes a real ID for a wrong one.

Nisa serves every user from one worker and has no rate limit of its own on
these routes, so Merv keeps at most `maxInFlight` (default 4) calls to it in
flight, and at most `maxInFlightPerProject` (half of it by default) for one
project, so one project's literature sweep leaves the others their turn; the
next waits its turn for up to `queueMs` (15 s) and is then refused with
`nisa_busy`. Retrieval has no per-call cost for a signed-in key (semantic
search spends Nisa's embedding calls), so there is no daily budget.

## Configuration

Only the name of the key's environment variable, never the key:

```json
{
  "keyEnv": "MERV_NISA_API_KEY",
  "origin": "https://api.rapidreview.io",
  "timeoutMs": 15000,
  "searchTimeoutMs": 40000,
  "maxResponseBytes": 2097152,
  "maxInFlight": 4,
  "maxInFlightPerProject": 2,
  "queueMs": 15000
}
```

`origin` may name only another https origin, or a loopback one for a test's
fake Nisa. The plugin refuses to start with `nisa_configuration` when the key
is unset.

## Privacy

Every call sends its input to Nisa, `https://api.rapidreview.io` by default:
a search's query in the request body, and `nisa.excerpts`' terms in the URL,
so they land in Nisa's web server and search-service access logs as well.
Nisa embeds a semantic search's query through DeepInfra's embeddings API, so
that text also reaches DeepInfra. The descriptions of `nisa.search`,
`nisa.semantic_search` and `nisa.excerpts` tell a model never to put
unpublished project text, credentials or signed links in a query. Unlike
`web.*`, the tools reach every worker, sealed reviews and workers whose shell
has no network included: each call goes only to the configured Nisa origin,
never to an address the worker chooses, but what it sends does leave Merv.

## Turning it on

The key is one `rr_sk_` key for the Nisa account Merv acts as: every agent's
search counts as that account's. A Nisa key has no scope: it is a credential
for the whole account, accepted by every route that needs a signed-in user
except the key routes themselves. Whoever holds it can read that account's
chats, transcripts and research documents, create, delete and share its lists,
start paid agent turns (`/api/chat/message`), and send shell commands to any
`nisa` CLI the account has connected (`/api/chat/sessions/<id>/user-shell`,
which asks no approval). So:

- Create a Nisa account for Merv alone, signed in with an address that is not
  a person's (anonymous accounts cannot mint keys). Never mint the key from
  your own account, and never use Merv's account for chats, lists or a
  connected `nisa` CLI.
- Mint the key once, signed in to that account in a browser, with
  `POST /api/sdk/auth/api-keys` (Nisa returns the raw key a single time), and
  keep it only in the private env file.
- To revoke it, list the account's keys with `GET /api/sdk/auth/api-keys` and
  delete this one with `DELETE /api/sdk/auth/api-keys/<id>`, both from that
  browser login (a key cannot manage keys), then remove the variable here.

Production and staging each read their own `/etc/merv/typescript.env`, and
`deploy/render-config.mjs` composes `nisa` and `nisa-tools` when it finds
`MERV_NISA_API_KEY` set. Add, with the real value only in that file (never in a
command line, a log or this repository):

```sh
# Nisa's key: rendering refuses one that is not rr_sk_… and never copies it.
MERV_NISA_API_KEY=CHANGE_ME
# Optional: another Nisa, by its https origin (default https://api.rapidreview.io).
# MERV_NISA_ORIGIN=https://api.rapidreview.io
```

The environment file is read when Main's container is created, and the render
runs on every start, so a bad value crash-loops Main. The image must also carry
this package: an older image's render ignores the variable. On each host,
staging first:

1. Release an image that contains `@merv/nisa` (`deploy/release.mjs`, as for
   any release). Until the key exists it composes exactly what it did before.
2. Back up the env file, add the variable, and dry-run the render with the
   running image, from the compose project's directory:

   ```sh
   cd "$(sudo docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' merv-typescript-control-1)"
   sudo MERV_TS_IMAGE="$(sudo docker inspect -f '{{.Config.Image}}' merv-typescript-control-1)" docker compose -f compose.yml run --rm --no-deps -T --entrypoint node control /app/deploy/render-config.mjs /tmp/render.json
   ```

3. Recreate Main on the same image (`docker restart` does not reread the env
   file), or let the next release recreate it:

   ```sh
   sudo MERV_TS_IMAGE="$(sudo docker inspect -f '{{.Config.Image}}' merv-typescript-control-1)" docker compose -f compose.yml up -d --force-recreate control
   ```

   A restart interrupts live Pi turns (see `deploy/PI_OPERATIONS.md`, Restarts
   and limits); choose a quiet window.

4. Check that the ready line lists the plugins, and that the tools answer:
   `sudo docker logs merv-typescript-control-1 2>&1 | grep '"status":"ready"' | tail -n1`
   should name `nisa` and `nisa-tools` as active; `nisa.search` should then
   appear in a project's MCP tool list and in a new Pi turn.

To turn it off, remove the variable and recreate Main the same way. Codex
workers see the tools once the runner that launches them carries the change that
names them (hosted: `deploy/hosted-release.mjs`, run by `release.mjs`).

## Deferred: Q&A

Nisa's question answering (`qa.ask`, `qa.get`, `qa.cancel` on the
`codex/nisa-mcp-plugin` branch) is not here. Nisa's main has no route for it:
`/api/chat/message` runs a whole agent turn with no idempotency, and
`/api/sdk/search` with `enrich: true` keeps papers in one worker's memory for
five minutes. Q&A needs the branch's `/api/plugin` backend deployed on Nisa's
side, and `qa.ask` is a paid, asynchronous write, so it would also have to be
named in execution policies. Until then, an agent answers from these reads with
its own model. Nisa's `/api/sdk/paper/{id}/pdf` is also left out: it links a
PDF, and no Merv tool yet turns a PDF into text an agent can read. Merv's
`paper.*` tools read and edit the project's own living paper, not an arXiv
paper, so an agent sees a paper's body only through `nisa.excerpts`: at most 20
passages of at most 2,000 characters that match its terms.

## Not verified

No call was made to Nisa: every test runs against a loopback fake built from
Nisa main 3489d7d (`project/backend/sdk_routes.py` and the tools it wraps).
Whether production runs that code, and enforces its keys
(`AUTH_REQUIRED=true`), is unverified. Before relying on it, run from Main one
`nisa.search` and one `nisa.paper` (for example `2303.08774`) with the real key.
