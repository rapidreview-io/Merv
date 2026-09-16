# Dependency and UI design consultation — Claude Fable, 2026-09-16

Both rounds completed with the actual `claude-fable-5` model, high effort, no fallback, tools or web requests. The input contained the approved source-free dependency inventory and UI behavior descriptions; the clarification added Fable's first answer and factual corrections. No new implementation excerpts or user records were sent. See [provenance](dependency-ui-fable-20260916-provenance.json).

This consultation assesses described design only. It did not inspect implementation, run tests, see the rendered UI or approve production. The independent [frozen-source readiness review](production-readiness-fable-final-v2-20260916.md) is a separate review.

## Local disposition and scope

The clarification corrects the first answer's assumption that Research was required to survive Knowledge removal. Under the previous requirements, only independent Reflections had to survive, so Fable withdrew its suggested optional Research→Knowledge edge. It retained Consolidation→Code because Consolidation actively seals and validates code, confirmed the direct Reviews/Feed→Artifacts and Research→Paper use, and corrected Runner from "airgapped" to a separate authenticated HTTP client. The adapter-hide control already exists.

**Subsequent user requirement:** while the clarification was running, the user requested that Research itself continue operating when stage components such as Consolidation are removed. That new resilience requirement was not in the reviewed clarification. The revised judgment below must not be treated as an approval or rejection of that new design. The follow-on proposal keeps State/Scope/Workflows required and makes Paper/Reflections/Knowledge optional alongside the existing optional Consolidation, with stage-specific waits and fail-closed evidence checks. The [subsequent standalone design review](research-optional-design-fable-20260916.md) now evaluates that new requirement. Its implementation and unload behavior still require separate review and testing.

The described small UI wave was endorsed: archive keyboard/focus parity, exact type/page-cursor-stack/record restoration scoped to project and actor, and project search with distinguishing IDs. Acceptance must reauthorize restored records, visibly reset stale cursor stacks rather than show false emptiness, and clear scoped navigation state at sign-out. These source changes are subsequent to the frozen readiness packet.

The first answer's suggested edge changes and new adapter-hide work should therefore not be applied mechanically. Direct service use alone is not a reason to discard the newer resilience requirement; optional consumers must explicitly handle an absent provider without broadening authorization or fabricating completion.

## Final clarification — verbatim

# Revised judgment

## 1. Research → Knowledge: required edge stands; I withdraw the optionality recommendation

My earlier reading was wrong: the prior decision promised only that *Reflections* survives Research/Knowledge unload, not that Research survives Knowledge removal. Given that, the required edge is coherent and actually the cleaner design:

- A required edge gives fail-closed semantics for free. If Knowledge unloads, Research unloads with it — no code path can issue an evidence authorization against an absent provider, no "provider absent vs. empty result" ambiguity to defend at every call site. Optionality would buy resilience Research doesn't need (Reflections, the thing that must survive, already has no edge) at the cost of exactly the absence-handling complexity you're trying to minimize.
- The narrower first optimization is correct and better: keep the edge, tighten the *contract usage* — when Knowledge returns only evidence/review/terminal-experiment IDs, skip optional Code capture lookups and unrelated claim hydration, while retaining exact source authorization and hash checks. That reduces coupling surface and latency without touching the graph or weakening authorization. It should be done as an internal Knowledge/Research contract change, verified by confirming no authorization decision ever consumed the now-skipped fields.

**Corrected recommendation: keep `research → knowledge` required; pursue the narrowed-call optimization instead.**

## 2. Consolidation → Code: keep required

The clarification resolves my audit question. Consolidation actively invokes Code (sealing reviewed proposals, provenance validation, potentially required Git execution) — it is a consumer of capability, not a manifest reader. The optionality already lives at the correct layer: `research → consolidation` is optional, so no-code research simply never enters Consolidation. Making Code optional *inside* Consolidation would create a service that can activate but cannot perform its defining function — a false capability, worse than the honest coupling. This mirrors the correct pattern elsewhere (adapters/optional children degrade capability; core function requirements stay required). **Keep required.**

## 3. Reviews → Artifacts, Feed → Artifacts, Research → Paper: keep

All three are confirmed direct service use (immutable review artifact checks, attached-metadata resolution, reading the accepted problem document). Per the map's own rule — declare what you use even when transitively reachable — retaining them is correct. No change.

## 4. Runner and adapter presentation: correction and closure

I overstated Runner as "airgapped." Corrected: Runner is a separate process with zero Cordis inject dependencies that makes authenticated HTTP calls to Merv. Its *lifecycle graph* isolation is still the right property — it can't be unloaded/broken by server plugin churn — but security review should treat it as an authenticated network client, not an isolated system.

With the corrected counts (79 required + 3 optional service edges across 25 providers; 62 mechanical adapter edges) and an existing adapter-hide toggle in the interactive DAG, my diagram recommendation is already satisfied. ~3.3 required edges per service provider is lean. No diagram work needed.

## Remaining edge concerns: none requiring change

With these clarifications, I have **no unresolved reason any listed required edge should change**. The only residual open items are observations, not edge changes: (a) the Research/Knowledge contract-narrowing above; (b) the earlier-noted adapter asymmetries (Workflows lacks a UI adapter; Sessions lacks a tools adapter) remain unconfirmed as intentional — worth a one-line confirmation, but they concern adapter presence, not graph edges.

## 5. The UI wave: sensible first step, yes

The scoped plan — archive keyboard/focus parity, exact type/cursor-stack/record restoration via per-history-entry navigation state scoped to project+actor, project search + distinguishing IDs, no framework/auth/token-semantics changes — hits the two genuine defects (accessibility, Back-state loss) plus the highest-value preference (project findability). Deferring shareable URLs is reasonable: history-entry state solves Back/reload, which is the actual reported failure; URLs can layer on later without rework, provided nothing in this wave implies links are shareable.

Two conditions to hold in acceptance testing: restoration must re-verify authorization at restore time (membership or record state may have changed between visits), and a stale cursor stack (deleted record, revoked access) must degrade to a visible reset rather than an error or silent empty state. Project+actor scoping should also be cleared on sign-out.

As before: this is design judgment on the described brief, not implementation or production approval.

## Initial consultation — verbatim, corrected by the clarification above

# Merv Review: Dependency Map + UI

Scope note: this is a judgment of the described inventory and behaviors only. I have not audited source, run code, or seen rendered screens; nothing here is production approval.

---

## Part 1 — Dependency map

### Q1. Which edges are right, which should change

**Three distinct categories in this graph:**

**A. Correct lifecycle/domain edges — keep.**
- Foundations: everything on `state`, `scope`, `tools`, `ui`, `api`, `blobs`, `domainEvents`. Correct direction, no cycles apparent.
- Domain facts: `artifacts → blobs` (bytes/metadata split), `experiments → claims` (experiments test claims), `code → sessions` and `code → artifacts` (provenance + sealed manifests), `sessions → workflows` (leases live in Workflows), task-type domains → `workflows/reviews/contextBuilder` (registration via existing deps, matching the callback-inversion decisions). The inverted directions are the strongest part of the map: Workflows, Reviews, and Context Builder do not depend on the domains that register into them, and Reflections has no Knowledge/Research edge. Runner with zero Cordis dependencies is exactly right.
- `code` optional to `experiments` and `knowledge`: correct pattern — capability degrades, domain stays up.

**B. Adapter clutter — do not touch code, fix the drawing.** ~31 adapters × 2 edges ≈ 62+ of the 144 edges are mechanical `{domain, registry}` pairs. This is visual noise, not coupling. Collapse adapters into their domain node in diagrams (or render as badges). Zero code change, removes roughly 45% of drawn edges. Note two asymmetries worth confirming as intentional rather than accidental: Workflows has tools but no UI adapter; Sessions has UI+API but no tools adapter (plausible if agents shouldn't self-manage sessions, but the brief gives no evidence either way).

**C. Candidates for change or verification:**
1. `research → knowledge` required — should likely become optional (Q2 below).
2. `consolidation → code` required — inconsistent with the stated pattern (`code` is optional to Experiments and Knowledge). If Consolidation only reads sealed manifests, those flow through Artifacts and the Code edge may be reducible or optional. If it validates code provenance directly, keep it. The brief gives no evidence which; verify before changing.
3. `reviews → artifacts`, `feed → artifacts`, `research → paper` — plausible (attachments; coordination of paper stage) but none is justified by the stated decisions. Audit for direct use. If directly used, keep per your own rule ("declare what you use, even if transitively reachable"). If dead, delete. Do not delete merely because reachable.

### Q2. Knowledge as Research dependency

**Recommend: optional child, fail-closed.** Your own stated decision already implies this: "If Research/Knowledge unload, core reflection work remains; extra research evidence authorization waits for the provider to return." A *required* edge contradicts that — it means unloading Knowledge kills Research entirely rather than degrading it.

The critical constraint is that Knowledge *authorizes* evidence, not just displays it. So optionality is only safe if:
- Absence is fail-closed: with Knowledge unloaded, `researchReferences`-dependent authorization **blocks and waits**, never falls back to a broader or empty-means-allowed result.
- The blocked state is surfaced explicitly ("evidence provider unavailable — research evidence authorization paused"), never silently, and never rendered as "no evidence exists."

**Verify before implementing:** every Research call site distinguishes "provider absent" from "provider returned empty"; unload/reload tests confirm no verdict is issued while absent; UI shows the paused state rather than hiding incomplete evidence.

### Q3. Code → Sessions

**Keep it; the boundary is correct.** Sessions owns execution/session continuity; Code validating managed execution/workspace provenance against the continuity owner is a genuine domain fact, not lifecycle clutter. The alternatives are all worse and explicitly ruled out: moving agent lifecycle into Workflows (which owns leases, not execution) or Scope (which owns principals, not sessions) would blur three boundaries you deliberately separated.

Could an existing contract reduce it? The brief shows no narrower public contract (e.g., a Sessions-registered provenance-attestation callback) that would let Code validate without a live Sessions dependency — so I won't invent one. Even if such a callback existed, Code unloading when Sessions unloads is arguably *desirable*: Code should not accept provenance it cannot validate. Keep required.

### Q4. Ordered minimal change set

1. **Diagram-only: collapse adapter pairs.** No code. Impact: readable graph. Verify: nothing.
2. **`research`: move `knowledge` from `requires` to `optional`**, with fail-closed semantics as in Q2. Impact: Research survives Knowledge unload per your stated decision; no evidence broadening. Verify: absence-handling at every call site, unload tests, explicit paused-state surfacing.
3. **Audit `consolidation → code`**; if usage is manifest-read-only, make optional (matching Experiments/Knowledge). Verify actual call sites first.
4. **Audit `reviews → artifacts`, `feed → artifacts`, `research → paper`** for direct use; keep if used, delete only if dead.
5. **Explicitly keep:** `code → sessions`, Knowledge's five-domain fan-in (it's a read-composer over public contracts; making its sources optional would hide incomplete evidence, which you forbade), `experiments → {claims, paper}`, `sessions → workflows`.

That's the whole list. 141 required edges for 25 services + coordination layers is not bloated once adapters are discounted.

### Q5. Coherence verdict and evidence needed

**Coherent, yes.** Layering is clean (infra → ownership domains → coordination → adapters), inversion is applied where it matters (Workflows/Reviews/ContextBuilder callbacks), archived-vs-live is separated honestly, and the machine Runner is properly airgapped from Cordis. The two required edges above (`research→knowledge`, `consolidation→code`) are the only ones in tension with your own stated decisions.

**Before anyone claims the implementation matches this map, require:** (a) generated import/injection graph diffed against declared edges — no undeclared service lookups, global registries, or cross-package DB reads; (b) unload tests: each adapter unloads with its domain live, each optional child absent without domain failure, fail-closed behavior for Knowledge; (c) transaction tests for verdict/transition/event/replay atomicity; (d) confirmation that the advisory-lock schema-writer serialization is documented as provisional, not scale-proven.

---

## Part 2 — UI

### Bugs vs. preferences

**Real defects (fix first):**
1. **Archive detail a11y** — no focus-on-open, no Escape, no focus return, and under 900px the panel opens above the scroll position (selection appears to do nothing). The agent panel already has the correct behavior; this is inconsistency, not new design.
2. **Back-button state loss** — archive type/page/selection and agent selection live only in React state; navigation destroys them. That's a navigation defect, not a preference.
3. **Stale pre-import project list** — a tab can show a stale successful empty list; membership isn't revalidated on token refresh. Correctness-adjacent.

**Usability preferences (valuable, second tier):** project search/ID subtitles; assignment-scoped tool-call filter; archive grouping/empty-state link.

### Implementation order

1. **Archive panel keyboard parity + narrow-layout scroll-into-view.** Reuse the agent panel's focus/Escape/return mechanism; on <900px, scroll the opened panel into view. Smallest change, fixes a genuine accessibility bug.
2. **URL state for archive (type + selected record) and agent selection, project-fenced.** Deep links must re-check authorization before render, discard late responses, and clear selection on project switch. For pagination: only encode the cursor stack if you can faithfully restore it; otherwise restore type+selection and reset to page 1 with a visible "returned to first page" note — never promise restoration you can't keep.
3. **Project chooser: search box + ID subtitle** on each row; keep membership order as default sort; keep create-project visually secondary below the list. Solves duplicate-name ambiguity with no layout redesign.
4. **Archive labeling + cross-link.** Sidebar group "Archive"; row label "Previous research (read-only)". On empty native Tasks/Experiments lists, *only when the archive plugin is registered*: "No native work yet. Imported research is available in Previous research (read-only archive)." Never implies old work is resumable — no new plugin, no dashboard.
5. **Tool-call filter: "All recent" / "Current assignment"** toggle. Retain explicit captions verbatim-style: "Last 100 calls across this agent's executions" and "~tokens (estimated from payload size ÷ 4; not model/billing tokens)". Lifetime totals stay separate and labeled as lifetime.
6. **Membership revalidation on chooser focus/visibility** (server already sends no-store and fresh-checks). Keep the rule that API errors never coerce to empty memberships.

### Labels and empty states

- File badges: "Available", "Metadata only — no file to download", "Not verified".
- Archive raw JSON: caption "Original imported record (provenance)" — sets expectation it's not a summary.
- Blocked-evidence state (ties to Q2): "Evidence provider unavailable — authorization paused", never an empty evidence list.

### Acceptance scenarios

- Open archive record on a 375px viewport → panel visible without scrolling, heading focused, Escape closes and returns focus to the row.
- Select archive type + record, open artifact, press Back → same type and record restored (or page-1 note shown), detail open, in the same project only.
- Paste an archive/agent deep link into another project's session → authorization checked, no cross-project data flash, graceful "not available here".
- Two projects named "Alpha" → chooser shows distinguishing IDs; typing filters by name or ID.
- Disable archive plugin → its sidebar row, empty-state link, and deep links all disappear/404 gracefully (no false capability).
- Switch tool-call filter → 100-call cap and estimate captions remain visible in both modes; lifetime totals unchanged.
- Stale tab regains focus → membership list refreshes; a transient API error leaves the prior list with an error banner, never an empty list.

**Verify before building:** the UI registry can carry route params for plugin-registered rows; late-response fencing hooks exist for deep-link resolution; the agent panel's focus utilities are reusable rather than inlined.
