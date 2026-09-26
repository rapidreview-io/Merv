# Nisa literature search

Merv's agents search the literature through `@merv/nisa`, a native plugin that
calls Nisa's public `/api/sdk` routes at `https://api.rapidreview.io` with one
deployment-wide `rr_sk_` key: the routes the `nisa` CLI uses, already served by
Nisa's main, so nothing needs deploying on Nisa's side. Internet search is a
separate plugin, `@merv/web`, modelled on how Nisa's own agents search the web;
the two are composed independently and both stay dormant until their keys are
configured. The package README ([packages/nisa/README.md](../packages/nisa/README.md))
has the full contract; this page is the overview and the activation runbook for
both.

## What it calls

| Tool                   | Nisa route                                  | Answers                                                      |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `nisa.search`          | `POST /api/sdk/search` with `enrich: false` | papers matching keywords (BM25 and citations), with snippets |
| `nisa.semantic_search` | `POST /api/sdk/semantic_search`             | papers whose abstracts are nearest a description             |
| `nisa.paper`           | `GET /api/sdk/paper/{id}`                   | one paper's record and abstract                              |
| `nisa.excerpts`        | `GET /api/sdk/paper/{id}/excerpts?q=&max=`  | passages inside one paper's full text                        |
| `nisa.related`         | `GET /api/sdk/paper/{id}/related?n=`        | papers similar to one paper                                  |

Every tool is a read of another service (`readOnly`, `openWorld`): it runs
without holding a PostgreSQL snapshot, and every agent gets it with no grant or
policy entry. Pi offers it to every turn, a reader's included, and runs it as
the person; leased workers call it as an open read (Codex workers because the
five names are in the runner's fixed project reads, Claude workers through
`mcp__merv`); MCP clients list it. Input is validated here more strictly than
Nisa validates it; each paper comes back with `identifier` (`arxiv:<id>`),
`title`, `authors`, `year` and `url` (`https://arxiv.org/abs/<id>`), which is
what `paper.cite` takes, and nothing Nisa sends beyond the allowlisted fields
passes. Each answer is sized to what Pi shows the model of one result. Failures
are `nisa_*` errors that repeat nothing Nisa wrote. Every worker launch's text
names the `nisa.*` searches for literature, and `web.search` for the rest of
the web where that launch is given it: a worker otherwise reads its tools as
project reads and answers from memory.

Queries leave Merv: Nisa receives each one (the passage search's terms in its
URL, so in its access logs), and embeds a semantic search's query through
DeepInfra. The descriptions tell a model never to put unpublished project text,
credentials or signed links in them; the package README's Privacy section has
the detail.

## How this replaces the earlier designs

- The first `@merv/nisa` (2026-09-13) was a two-tool REST adapter published as
  a remote catalog: its tools needed Access grants and credential bindings, and
  remote tools never reach Pi. It was removed on 2026-09-14. Its bounded HTTP
  client is what this plugin ports; its catalog and grant model are not.
- The generic route, Nisa's own six-tool MCP server attached through
  `@merv/mounts` ([history](NISA_PLUGIN_IMPLEMENTATION.md)), still works for a
  Nisa that runs the unmerged `codex/nisa-mcp-plugin` branch, and
  `npm run test:nisa-mcp` still exercises it. It is not what production uses:
  mounted tools (`_nisa.*`) need per-actor grants and are never offered to a
  conversation, and that branch's backend is not deployed. Do not compose both
  under the same agents: the native `nisa.*` tools are the supported ones.

## What is deferred

- **Q&A** (`qa.ask`, `qa.get`, `qa.cancel`). Nisa's main has no route for it:
  `/api/chat/message` runs a whole agent turn with no idempotency, and
  `/api/sdk/search` with `enrich: true` keeps its papers in one worker's memory
  for five minutes. It needs the branch's `/api/plugin` backend deployed on
  Nisa's side, and `qa.ask` is a paid, asynchronous write that execution
  policies would have to name. Until then an agent answers from these reads
  with its own model.
- **PDF links** (`/api/sdk/paper/{id}/pdf`): the route links a PDF, and no
  Merv tool yet turns a PDF into text an agent can read. Merv's `paper.*`
  tools are the project's own living paper, not arXiv papers, so an agent sees
  a paper's body only through `nisa.excerpts` (at most 20 passages of at most
  2,000 characters that match its terms).
- **Per-person Nisa accounts.** One key means every agent's search is that one
  Nisa account's. A Nisa key has no scope: it is a credential for the whole
  account, so a leaked key reads that account's chats, transcripts and research
  documents, changes and shares its lists, starts paid agent turns, and sends
  shell commands to any `nisa` CLI the account has connected (the user-shell
  route asks no approval). Hence the dedicated account below. Merv has no
  per-person secret bindings for it.

## Turning on literature and internet search

Production and staging each have their own `/etc/merv/typescript.env`
(root-owned, 0600), read when Main's container is created. On each start
`deploy/render-config.mjs` composes a plugin only when its variable is set, and
checks each key's shape without ever copying it into the rendered config.
Nothing here needs a database migration.

First create a Nisa account for Merv alone, with an address that is not a
person's (anonymous accounts cannot mint keys), and never use it for chats,
lists or a connected `nisa` CLI; never mint the key from your own account.
Signed in to it in a browser, mint one key with `POST /api/sdk/auth/api-keys`
(Nisa shows the raw key once). To revoke it later, delete it from that browser
login with `DELETE /api/sdk/auth/api-keys/<id>` (its id is in
`GET /api/sdk/auth/api-keys`; a key cannot manage keys) and remove the
variable.

Add to `/etc/merv/typescript.env` on **staging** first, then **production**,
with real values only in that file (never on a command line, in a log or in
this repository):

```sh
# @merv/nisa: the Nisa account's rr_sk_ key.
MERV_NISA_API_KEY=CHANGE_ME
# Optional: another Nisa, by its https origin (default https://api.rapidreview.io).
# MERV_NISA_ORIGIN=https://api.rapidreview.io

# @merv/web: Tavily's key (tvly-…), and/or the NAME of a variable holding an OpenAI key for
# the fallback. Either one composes it.
MERV_TAVILY_API_KEY=CHANGE_ME
# MERV_WEB_FALLBACK_KEY_ENV=MERV_PI_MODEL_API_KEY
# MERV_WEB_FALLBACK_MODEL=gpt-6-luna
# Budgets per UTC day, and calls in flight:
# MERV_WEB_DAILY_CALLS_PER_PROJECT=200
# MERV_WEB_DAILY_CALLS=1000
# MERV_WEB_FALLBACK_DAILY_CALLS=200
# MERV_WEB_MAX_IN_FLIGHT=8
```

Either plugin may be turned on alone. How the change is picked up:

1. **The image must carry the packages.** An image built before `@merv/nisa`
   and this version of `@merv/web` ignores the variables. Release one first
   (`node deploy/release.mjs --host <alias> --public <origin>`); without the
   variables it composes exactly what it did before.
2. **The next release picks the variables up.** `release.mjs` backs up the env
   file and runs `docker compose up -d` with the new image, which recreates Main
   and rereads the file. To turn them on without a release, dry-run the render
   and recreate Main on its current image, as the package READMEs'
   "Turning it on" sections show; `docker restart` does not reread the file. A
   recreate interrupts live Pi turns (see `deploy/PI_OPERATIONS.md`).
3. **A bad value stops Main.** The render refuses a key of the wrong shape and
   Main crash-loops, so dry-run the render with the running image before
   recreating (the command is in both READMEs). To turn a plugin off, remove its
   variables and recreate Main.
4. **Check.** The ready line (`sudo docker logs merv-typescript-control-1 2>&1 |
grep '"status":"ready"' | tail -n1`) lists `nisa`/`nisa-tools` and
   `web`/`web-tools` as active, and the tools appear in a project's MCP tool list
   and in a new Pi turn. Then run one `nisa.search`, one `nisa.paper`
   (`2303.08774`), one `web.search` and one `web.extract` of a page that search
   returned, with the real keys; no test here has called the real services.
5. **Workers.** Codex workers see the `nisa.*` tools, and the launch text that
   names them, once their runner carries the change that lists them (hosted
   runners: `deploy/hosted-release.mjs`, run by `release.mjs`). `web.*` reach
   only hosted, unsealed Codex launches and unsealed Claude launches, whose
   shells already have the network.
6. **Size the web budget for Fleet.** Every Fleet agent in a project, its Pi
   turns and its MCP clients share `MERV_WEB_DAILY_CALLS_PER_PROJECT` (200 a
   day by default), and every project shares `MERV_WEB_DAILY_CALLS` (1000).
   With `MERV_FLEET_WORKFLOW_ENABLED`, a wave of `MERV_FLEET_PROJECT_LIMIT` (5)
   agents making 20 calls a step spends 200 in two steps, and later steps that
   day get `web_budget_exhausted`. Raise both to about the project limit times
   the calls a step makes times the steps a project runs a day, as far as the
   Tavily plan allows.

Before turning web search on, read its [privacy](../packages/web/README.md#privacy)
and [cost](../packages/web/README.md#cost-controls) sections: queries leave
Merv for Tavily (and OpenAI through the fallback), and its budgets live in
memory.

## Verify locally

```sh
export MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:55432/merv
node --import tsx --test tests/nisa.test.ts tests/web.test.ts tests/open-world-reads.test.ts
node --test deploy/render-config.test.mjs
```

The Nisa tests run against a loopback fake built from Nisa main 3489d7d's
`sdk_routes.py`; whether production runs that code, and enforces its keys, is
unverified until the checks in step 4.
