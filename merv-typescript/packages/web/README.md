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
  `web_extract`, and runs them as the person;
- **leased workers** may call them as open reads their policy never names:
  Claude workers through `mcp__merv`, Codex workers because both names are in
  the runner's fixed project reads (Codex's own hosted search stays disabled);
- **MCP clients** list them with `readOnlyHint` and `openWorldHint` set.

Descriptions name no address, since the Pi relay refuses a schema that does, and
tell the model to cite what it uses as Markdown links and to treat web text as
untrusted source material.

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
  characters per result and 24,000 in all. A result without an http(s) address
  is dropped; nothing else a provider sends is passed on.
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
  The content is always capped at 20,000 characters.
- A page Tavily could not read is `status: "error"` with its reason and a hint
  to search instead.

## Providers and failures

Tavily is called at `POST /search` and `POST /extract` with the key as a bearer.
The fallback calls OpenAI's `POST /v1/responses` with
`tools: [{ type: "web_search" }]`, `include: ["web_search_call.action.sources"]`,
`reasoning: { effort: "low" }`, 2,048 output tokens (4,096 for an advanced
search) and `store: false`, from inside the handler; the Pi relay would refuse a
hosted tool. Every call has a deadline over all its attempts (Tavily 30 s, the
fallback 90 s), follows no redirect, reads at most 8 MiB of JSON, and retries
twice what may pass: no answer, 408, 425, 429 or 5xx.

Search falls back exactly when Nisa does: Tavily has no key, or answers 401,
403, 432 or 433, or still 429 once its retries are spent. Any other failure is
Tavily's and is not retried through the fallback. Errors say at most an HTTP
status, never what a provider wrote:

| Code                                                                   | Status | Meaning                                                    |
| ---------------------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| `web_budget_exhausted`                                                 | 429    | The project has made its calls for the UTC day             |
| `web_busy`                                                             | 429    | The process has its maximum of calls in flight             |
| `web_unavailable`                                                      | 503    | No provider has a key (for `web.extract`: Tavily has none) |
| `web_provider_refused`, `web_quota_exhausted`                          | 503    | Tavily refused its key or its plan, with no fallback       |
| `web_request_refused`                                                  | 422    | Tavily refused the request itself (HTTP 400)               |
| `web_timeout`                                                          | 504    | The deadline passed                                        |
| `web_upstream_error`, `web_invalid_response`, `web_response_too_large` | 502    | Anything else a provider did                               |
| `web_stopped`                                                          | 503    | The plugin is unloading                                    |

A refusal is never 401 or 403, which a transport would take for the caller's
own.

## Cost controls

Nisa has none; Web has two, both in memory, so a restart forgets them:

- `dailyCallsPerProject` (default 200): each call that reaches a provider counts
  once against its project's UTC day, fallback included, whether or not the
  provider answers. An answer that needs no provider (`needs_query_terms`,
  `needs_valid_url`) costs nothing, and neither does a call these two limits
  refuse.
- `maxInFlight` (default 4): calls in flight in this process; one more is
  refused at once.

## Configuration

Only names of environment variables, never keys:

```json
{
  "keyEnv": "MERV_TAVILY_API_KEY",
  "fallback": { "keyEnv": "MERV_PI_MODEL_API_KEY", "model": "gpt-6-luna" },
  "timeoutMs": 30000,
  "maxResponseBytes": 8388608,
  "maxInFlight": 4,
  "dailyCallsPerProject": 200
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
# MERV_WEB_MAX_IN_FLIGHT (default 4, 1-64).
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

## Not verified

No call was made to Tavily or OpenAI: every test runs against loopback fakes
built from `tavily-python` 0.7.23 and the Responses API's documented shapes.
Before relying on it, run one search and one page read from Main with the real
keys, and one search with Tavily's key removed if the fallback is configured.
