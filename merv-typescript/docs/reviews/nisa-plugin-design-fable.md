# Nisa plugin architecture debate with Claude Fable

Two approved rounds completed on 2026-09-13 using Claude Code 2.1.261 and
explicitly pinned `claude-fable-5` at high effort. Each process exited 0 with a
successful result. This was a source-based design debate, not a code review with
executed tests or verification of a deployed Nisa service.

The first submission was rejected by automatic approval review before process
creation. The user then explicitly approved the exact prepared packet and one
rebuttal using the same material. The packet hash was reverified before the
approved invocation and after both rounds. The second round added Fable's first
answer and the root agent's rebuttal, with no additional source excerpts.

| Round | Outcome                     | Requested and reported main model | Stderr / permissions             |
| ----- | --------------------------- | --------------------------------- | -------------------------------- |
| 1     | `success`; exit 0; 91,987ms | `claude-fable-5`                  | `0` bytes; no permission denials |
| 2     | `success`; exit 0; 65,909ms | `claude-fable-5`                  | `0` bytes; no permission denials |

Both calls used safe/restricted modes, no tools, strict empty MCP configuration,
and no session persistence. No fallback model was configured. The CLI also
reported auxiliary `claude-haiku-4-5-20251001` usage in both responses; the result
does not identify its purpose. This is recorded provenance, not a second
requested reviewer. Reported web-search requests were zero. No Nisa credential,
environment file, private runtime data, or additional repository source was
sent. Raw CLI responses remain private temporary artifacts.

| Evidence packet                                                             | Bytes | SHA-256                                                            |
| --------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------ |
| Original argument and selected ranges from ten Nisa source files at 3489d7d | 29616 | `ef09a04798a1fe115ea4e2a2c93b3a09e7085cae09cd03436f3b4ded6a328ae5` |
| Same packet, actual first answer, and approved single rebuttal              | 44104 | `b9045c65a88a2fb1d8366ef18e60d4dcff2d63a7a4ddf094e5518d104a7184ee` |

## Outcome and independent disposition

Agreement: retain Python retrieval and the Rust CLI; preserve Tantivy's existing
process boundary; start with a small retrieval composition and injected metadata
rather than a broad TypeScript rewrite. Use executable compatibility fixtures,
explicit direct-only behavior for new retrieval consumers, selected imports and
owned provider lifetimes. A new metadata seam can support two fixture instances
without requiring a rewrite of every legacy singleton.

Fable initially proposed dropping MCP and removing the enrichment compatibility
shim. The rebuttal challenged both the ordering and several evidence overclaims.
Fable accepted that source inspection does not prove deployed behavior; a named
removal date does not authorize a breaking change; nullable graph fields do not
prove graph dependencies can be omitted; and a name-to-callable registry does
not establish dependency activation or disposal. It also corrected a proposed
boot test that would inadvertently drop API-key authentication dependencies.

The remaining disagreement is how much justification MCP needs. Fable would make
it conditional on a second consumer or parity evidence. The root recommendation
puts a Nisa-owned interface in the sequence because common plugin integration
is an explicit user goal. A second client is a compatibility test, not a demand
prerequisite. Result, identity and lifecycle parity plus authorized real-service
verification remain completion gates before replacing Merv's working adapter.

Some final-round recommendations are not adopted literally:

- Merv's current REST adapter already withdraws admission, drains calls and
  exposes close semantics; do not rebuild those mechanisms as new work.
- An arbitrary count of five edited files does not determine whether an
  extraction is sensible. Switch to a thin facade first if a focused retrieval
  composition requires broad unrelated runtime changes.
- Stable semantic JSON parity is the requirement; byte identity is unnecessary
  for object ordering or legitimate transport metadata. Begin with controlled
  characterization fixtures and retain a separate real-service proof. Production
  responses are not a prerequisite to all local refactoring work.
- Preserve the documented legacy enrichment behavior until deliberately changed;
  a new direct interface must never inherit implicit enrichment. No breaking
  shim removal was authorized by this architecture discussion.

The user subsequently clarified that Nisa and Merv will share authentication
and that Nisa should expose agentic Q&A after checking the user's quota. That
clarification expands the root proposal. It arrived after the approved second
round had completed and was assessed by a separate local source audit. The
shared-auth/Q&A addendum is not presented as Fable-reviewed material; no third
Fable call or additional source export was made. See the
[updated proposal](../NISA_PLUGIN_DESIGN.md).

## Actual round1 answer

The following response is retained as received. Its evidence overclaims are
corrected in the rebuttal, final answer and independent disposition above; it
must not be read as a report of deployed behavior.

## Round 1 — Fable's position

TLDR of my disagreement: your ordering treats the contract as the missing piece, but the excerpts show the contract mostly exists already — it lives in the `string_search` tool and the `/search` docstring. The actual blocker to plugin-friendliness is startup/data coupling in `server.py` and `data_loader.py`, plus one live violation of your own principle 2 that has a deadline attached. And I'd cut MCP from the near-term plan entirely.

### Strongest objection to your ordering

Your step 2 ("define versioned contracts + conformance tests first, across scope/auth/cost/timeout") front-loads formalization of a surface that is already substantially converged. `sdk_routes.py:559-562` states outright that fan-out/dedup/merge/sort/paginate live in the tool "so the CLI, the SDK, and in-process agents share the same implementation." The docstring at `sdk_routes.py:564-583` _is_ a contract — precise about list-mode fanout, caps, month-precision date semantics, and "unparseable is a 400, never a silently-dropped filter." Writing a versioned contract document before touching code risks freezing accidental surface into v1: the `url`/`source`/`why` decoration added only at the REST layer (`sdk_routes.py:635-647`), and especially the legacy-SDK enrichment shim.

That shim is the sharper problem: `_wants_agent_enrichment` (`sdk_routes.py:224-244`) makes a bare `python-httpx/` user agent _implicitly launch background-agent enrichment_ — a direct violation of your "raw search must never implicitly launch synthesis," live in production today, with a removal date already named in code (`_LEGACY_SDK_ENRICHMENT_SHIM_REMOVE_AFTER`). Your plan defers the one contract item with a clock on it behind a general contract-authoring phase. Invert this: codify search+paper only, kill the shim on schedule, and let the rest of the contract stay as docstrings until a second consumer needs it.

Second objection to ordering: extraction (your step 3) is half-done and you're proposing to redo the finished half. Keyword retrieval is _already_ a separate service — `string_search.py:29` calls a Tantivy FastAPI server over HTTP with its own lifespan management (`search_server.py:124-139`). The un-extracted piece is metadata: `get_paper_metadata` (`data_loader.py:360-391`) is in-process pandas over a 2.7M-row CSV loaded eagerly at Flask boot (`server.py:198-209`), and it's imported by the search tool, the SDK routes, and semantic search alike. "Extract the smallest retrieval service" should really read "extract the metadata provider" — that's the single seam whose absence forces every consumer to become the monolith.

### What I'd change today

**Drop MCP from the plan.** The existing `@merv/nisa` plugin already does everything MCP would buy you: forces `enrich:false`, per-call credentials, duration/byte limits, redirect rejection, and 187 passing checks with a controlled unload proof. MCP doesn't retire the REST surface — CLI and web still need it — so it _adds_ a protocol boundary rather than replacing one. Your own alternative "keep the small REST plugin indefinitely" is the right answer, not a fallback. Revisit MCP only when a second MCP-speaking consumer exists or Merv's generic Mounts delivers something the custom plugin can't (and per your context, native work already survives mount disappearance, so drain semantics aren't that something).

**Cut the provider list from six to three, and only build one.** Your point 5 proposes providers for metadata, keyword, embedding, graph, research execution, and sandbox bridge. The excerpts show three seams that already exist physically: Tantivy-over-HTTP (done), Supabase+DeepInfra for semantic (already degrades gracefully when unconfigured — `semantic_search.py:82-96`), and in-process pandas metadata (the broken one). Graph overlay is already nullable in practice: `/paper` returns `cluster: null, pagerank: null` when the node is absent (`sdk_routes.py:862-869`). Research execution and the bridge lease machinery (`session_capabilities.py`) are a different subsystem with its own capability model — don't fold them into a retrieval provider taxonomy, and don't try to unify Nisa's `ClientCapabilities` with Merv's Tools/Access/Credentials; map them at the adapter.

**Drop the "two instances with different config" test for the Python core.** This is where you propose the most abstraction for the least return. The codebase is module-global singletons all the way down: `_papers_df` with double-checked locking (`data_loader.py:76-96`), cached DeepInfra/Supabase clients behind `_clients_initialized` (`semantic_search.py:52-98`), module-constant `SEARCH_SERVICE_URL`. That test matters for Cordis plugins in one Node process; for Nisa, the process boundary _is_ the instance boundary, and refactoring every singleton to pass it is cost without a consumer. Keep that test for the Merv side, where it belongs.

### Minimal contract units, from the actual code

- **search**: `query` str|list[≤8], `max_results` ≤50, `offset` ≤500, `author`, month-precision date bounds, 400 on unparseable; envelope `{count, offset, limit, truncated, papers[]}` plus `index_latest_pub_month` — keep that field in v1, it's load-bearing (the BM25 and embedding indexes update on different cadences, `search_server.py:68-73`, and callers need to distinguish "no match" from "index predates my window").
- **paper**: core metadata (arxiv_id, title, authors, abstract, year, citation_count, url, categories) with graph fields explicitly nullable. Also: `/paper` currently has **no `@require_auth`** while `/search` does (`sdk_routes.py:556-557` vs `846-847`). Decide whether that asymmetry is intentional before writing it into a versioned contract.
- **enrichment**: `enrich` must be literal `true`; shim removal date becomes a contract-tested commitment.
- **errors**: 400/401/404/500 as already implemented.

### First vertical slice and falsifiable completion tests

Slice: a **retrieval-only server profile** — env-flagged boot path serving only `/search` and `/paper`, with `get_paper_metadata` injected as a provider, no imports of `generate_tiles`, `upload_tiles`, `agents.routes`, or `list_sharing`.

Tests that can fail:

1. Retrieval profile boots with no Supabase/DeepInfra/tiles config and serves both endpoints; assert via `sys.modules` that tile/agent modules were never imported.
2. Golden conformance: a fixture set (list-query fanout, each date-format variant, an unparseable date expecting 400, a paper absent from the graph expecting `cluster: null`) returns identical JSON from monolith and retrieval profile.
3. A `python-httpx/` UA request returns results with no `session_id` and zero agent invocations — the shim's removal, contract-tested.
4. `load_similarities` and graph cache load are never called in the retrieval profile (startup independence, not just endpoint independence).
5. Kill the Tantivy service mid-run: `/search` returns a structured 5xx, `/paper` still returns 200 — proving the two seams fail independently.

These are pass/fail against source-level assertions and a running process; note I'm reasoning from excerpts, not execution — test 2's fixture set should be built from real responses before refactoring, or it proves nothing.

### Retained tradeoffs

The retrieval profile still eagerly loads the 2.7M-row papers CSV into pandas — accepted for slice 1; a real metadata service is slice 2 only if memory or cold-start actually hurts. Two index-freshness cadences remain caller-visible (correctly — hiding them would be worse). Merv keeps its custom REST glue indefinitely; I'm arguing that's fine, you'll argue it's debt — that's the crux for round 2.

One conflation to concede back to you: your point 4's "a thin HTTP facade is not proof of internal independence" is right, and it cuts against your own MCP step — MCP is also just a protocol facade. The proof of plugin-friendliness is test 1 and 4 above, in-process, protocol-free. The in-process plugin surface Nisa already has is `TOOL_REGISTRY` (`tool_registry.py:25-43`); adding a tool there requires no new architecture at all.

## Root rebuttal submitted for round2

# Round 2 — root rebuttal and request for a final design judgment

This is the user's approved single rebuttal using the SAME source packet. No new source excerpts, secret values or repository data have been added. The original packet and your actual first response above are debate context. Now answer this rebuttal; no tools or execution. Keep the final response under1100words. Please revise where warranted and retain substantive disagreements where not.

1. I accept your strongest simplification: retain the existing Tantivy process and Python/Rust implementations; make metadata and selected retrieval composition the first internal seam. My "contract first" should mean a small executable compatibility matrix alongside the first vertical slice, NOT a schema platform, SDK generation project, or new versionedURL before work. Preserve existing data/sources/effective pagination/freshness and define explicit direct-only behavior. An external REST client already avoids importing the monolith, so "every consumer becomes the monolith" overstates the current metadata coupling; it affects embedded/server composition.

2. I disagree with dropping MCP indefinitely. The user specifically wants stack components to fit a common plugin mechanism and be independent systems. Merv already has a generic Mounts plugin for MCP and a Nisa-specific static two-tool REST adapter. The REST adapter implements useful safety behavior but is NOT a discoverable Nisa-owned catalog: Merv owns its tool schemas/descriptions and this contract translation. A Nisa-owned MCP endpoint lets that ownership move upstream and lets Merv attach selected tools through configuration. REST remains for CLI/web, which is fine; the goal is reusable tool ownership, not replacing REST. A second real MCP consumer strengthens the case, but doesn't Merv's already-working generic mount infrastructure plus eliminating special-case ownership justify a narrowly scoped MCP slice? I will NOT claim the facade itself fixes internal modularity. Choose a concrete trigger and place in order for MCP rather than treating it as universally needed or universally redundant.

3. There are two legitimate sequences: (A) small retrieval profile and metadata injection, then MCP on that boundary; (B) tiny contract fixtures plus Nisa-owned HTTP-to-MCP facade first, then internal extraction. B preserves existing ranking/metadata by delegating REST and limits initial changes; A tests internal independence sooner. Under the user's preference for small fully integrated steps, which first completed deliverable is best, and what exact result would make us switch order? A generic rewrite of all singletons is not on the table. I accept process-per-instance as the initial production boundary, but a small injected metadata provider can still be tested with two fixture instances without refactoring the whole backend. Do not conflate a focused isolation test with a demand for a universal runtime.

4. Please correct several source-evidence overclaims. The excerpts are not deployment verification: implicit enrichment exists in inspected source, but "live in production today" wasn't established. A named removal-date constant/warning doesn't establish that a breaking compatibility change is authorized or already scheduled. Preserve the legacy route's explicit compatibility behavior until deliberately deprecated; the new direct operation must always send/require literal enrich:false. The semantic clients can be absent at initialization; that isn't proof that invoking semantic search then works. Nullable graph fields when a node is absent are NOT proof that the graph provider can be omitted: paper_metadata calls _get_global_node_row unconditionally in the excerpt. Make absent graph a tested composition choice and preserve the response schema.

5. Your suggested retrieval boot with "no Supabase config" needs an auth qualification. The packet shows API-key verification needs a Supabase client and attaches a Nisa principal; paper is public and search is protected. A new retrieval profile must not disable auth to pass an independence test. Test with an explicit supported authenticator/stub in localfixtures, and validate enabled production auth dependencies. Merv's stricter grants plus credential binding are local policy, not a reason to change canonical Nisa public paper access. A future MCP facade must establish whether it is the same legitimate Nisa auth resource or use separately bound upstream credentials; the packet doesn't establish future token audiences. No automatic bearer passthrough assumption.

6. TOOL_REGISTRY is a useful existing name→callable catalog, but the shown eager imports and session factories do not demonstrate dependency activation, withdrawal, drain, or resource disposal. "Add a tool by inserting a callable" is not the user's full plugin-independence goal. Preserve it as a consumer/registration seam; don't present it as evidence that lifecycle work is already done. Conversely, adding Cordis to a TS facade cannot dispose Python globals or accepted remote jobs.

7. My proposed small acceptance gates: (i) existing routes retain behavior; direct retrieval never launches research, and complete source fields plus effective pagination/freshness survive transport; (ii) retrieval-only composition omits graph/model/bridge code/resources and still enforces supported auth; Tantivy loss affects search but paper lookup survives; (iii) every resource-owning adapter has explicit admission/close and bounded drain, with no claim that dropping HTTP kills an upstream thread; (iv) if MCP ships, actual Mounts + another client negotiation/identity/result/unload parity and separately authorized real Nisa proof precede retirement of current REST glue. The pending live proof remains pending.

Please return: what you concede/change after this rebuttal; what you still disagree with; one concrete ordered plan of 3–5 small integrated slices (including where MCP is optional or required and why); minimal first-slice dependencies and pass/fail gates. Avoid new claims about deployment, billing, or unstated versions. Explicitly distinguish your final recommendation from facts proven by the code.

## Actual round2 answer

## Round 2 — Fable's response

### What I concede

**The four evidence overclaims — all fair, corrected.** (1) "Live in production today" was source inference; the excerpts prove the shim exists in inspected source at `sdk_routes.py:224-244`, not that any deployment runs it. (2) The `_LEGACY_SDK_ENRICHMENT_SHIM_REMOVE_AFTER` constant proves someone _named_ a date, not that removal is authorized or scheduled; my round-1 test 3 (contract-testing the shim's removal) was wrong-way-round. Slice 1 must pin the shim's _current_ behavior in fixtures — legacy UA triggers enrichment plus the warning — so that removal, when deliberately decided, is a one-line fixture flip rather than a silent break. (3) Graceful client absence at init (`semantic_search.py:82-96`) proves clean degradation of _initialization_, not that invocation works when configured — agreed. (4) Nullable `cluster`/`pagerank` proves the _schema_ tolerates absence, not that the graph provider is omittable: `paper_metadata` calls `_get_global_node_row` unconditionally (`sdk_routes.py:864`). Making absent-graph a real composition choice requires a code change — an injected, nullable graph-lookup provider — and I fold that into slice 1 rather than claiming it's free.

**The auth qualification — important catch.** My "boots with no Supabase config" test conflated two distinct Supabase dependencies: semantic-search storage (droppable in a retrieval profile) and API-key verification in `auth.py:58-75` (not droppable — `/search` is `@require_auth`, `/paper` is public, and that asymmetry is canonical Nisa behavior until deliberately changed, not something a profile may flatten). Revised test: retrieval profile boots with no _semantic/tiles/agent_ config, auth **enabled**, using a fixture authenticator behind the same `require_auth` interface; a separate check validates the production auth path's dependencies are intact. And agreed on MCP auth: the packet establishes nothing about token audiences, so no bearer-passthrough assumption — the facade's credential binding is an open design question, resolved before slice 4 ships, not inherited.

**Two-instance testing, scoped.** You're right that I over-rotated. A _newly injected_ metadata provider can and should be constructed twice with different fixture data in one test process — that's cheap and catches hidden module-global state in the new code. What I retain: this requirement applies only to new seams; it must never become a gate on legacy singletons (`_papers_df`, cached clients), where process-per-instance remains the boundary.

**TOOL_REGISTRY.** Conceded: it's a name→callable registration seam, not evidence of activation/withdrawal/drain/disposal. I overstated it as "no new architecture at all." It stays useful as the in-process consumer attach point; lifecycle work is real and unstarted. Your converse point is also right and worth keeping on the record: Cordis on a TS facade cannot dispose Python globals or cancel accepted remote work — lifecycle must live on the Python side of the boundary.

### What I still disagree with

**MCP justification, not MCP placement.** I accept a concrete trigger and slot (below) — you've won "not indefinitely deferred." But I reject "eliminating special-case ownership" as sufficient justification _today_, for two reasons grounded in your own packet. First, the current REST adapter's safety behavior — forced `enrich:false`, per-call credentials, duration/byte limits, redirect rejection — is implemented and proven (187 checks, controlled unload). Moving tool ownership upstream means re-establishing every one of those properties under generic Mounts, and the packet says the real-service proof is _still pending_ a fresh authorized credential. Trading a proven special case for an unproven general mechanism is a cost, not a cleanup. Second, "Merv owns the schemas" is only debt if the schemas churn; two static tools over a stable envelope churn slowly. So: MCP is justified _conditionally_, and the condition is parity evidence, not architectural taste.

**Shim disposition can't float.** Preserving compatibility until deliberate deprecation — yes. But "until deliberately deprecated" with no forcing function means the one live violation of "direct retrieval never launches research" persists ownerless. My retained demand: slice 2 includes a human decision on the shim's date, recorded in the fixture suite. The decision may be "keep it another year" — fine — but it must be a decision, not a drift.

### A vs B: choose A, with an explicit switch condition

**A first** — retrieval profile and injected metadata/graph providers, then MCP on that boundary. Reason: B's facade delegates to the monolith, so its completion proves protocol translation only — which we both agree isn't the goal — while A's completion proves the internal seam the whole plan depends on, and A needs no new credential, no TS changes, and no Merv coordination.

**Switch to B if:** building the retrieval profile shows the metadata seam isn't where the excerpts suggest — concretely, if injection requires modifying more than the boot path plus `data_loader` accessors (say, >5 modules touched), the seam is a research project and fixtures-plus-facade delivers value sooner. Also switch if a second real MCP consumer materializes before slice 1 lands, since that flips MCP's cost/benefit independently.

### Ordered plan

**Slice 1 — Fixtures + retrieval profile.** Golden compatibility fixtures captured from live monolith responses _before_ any refactor (list-query fanout, all date formats, unparseable-date 400, graph-absent paper, legacy-UA shim behavior pinned as-is, `index_latest_pub_month` present). Env-flagged boot serving `/search` + `/paper` with injected metadata and graph providers, auth enabled via fixture authenticator. Gates: byte-identical fixture parity; `sys.modules` shows no tiles/agents/semantic imports; Tantivy kill → structured 5xx on `/search`, 200 on `/paper`; new providers pass the two-instance fixture test.

**Slice 2 — Direct-only commitment.** All new consumers (SDK, CLI, Merv adapter) send literal `enrich` explicitly; shim disposition decided and dated; fixture suite encodes the decision. Gate: no code path reaches enrichment without literal `enrich:true` except the pinned shim.

**Slice 3 — Adapter lifecycle.** Explicit create/close on injected providers; Merv REST adapter gains admission/close and bounded drain (your gate iii); unload-during-work and reload-without-duplicates tested. No claim that dropping HTTP kills upstream work.

**Slice 4 (conditional) — Nisa-owned MCP.** Trigger: slices 1–3 green **and** either the authorized real-credential Mounts proof succeeds or a second MCP consumer exists. Ships search+paper only, same contracts as slice 1's providers, credential binding designed explicitly. REST glue retires only after result/permission/unload parity per your gate iv. If the trigger never fires, the REST adapter persists — and that outcome is acceptable, not a failure.

First-slice dependencies: none new — existing Tantivy service, existing CSV data, fixture authenticator, no TS work, no schema tooling, no credentials beyond what the monolith already needs.

### Proven vs. judgment

Proven from source: shared tool implementation across surfaces; shim mechanism and its warning; Tantivy as a separate HTTP service; in-process pandas metadata; unconditional graph-row lookup; auth asymmetry between `/search` and `/paper`; freshness field semantics. My judgment, not established fact: A-before-B ordering, the >5-modules switch threshold, MCP's trigger condition, and the claim that schema ownership in Merv is tolerable debt. The pending live-service proof remains pending; nothing above claims deployed behavior.
