## Critique

The build is technically clean (focus trapping, deterministic nav, honest empty/error states) but it fails the migration user on their first minute: **the only content they have — imported research — is the least visible thing in the product.** In `navigation.ts`, `legacy-history` is mapped to the last section ("Activity"); in `overview.tsx`, `ArchivePanel` is the last card in the side rail and renders two sentences of static text while four empty native panels ("No experiments yet…") occupy the primary column. The user's mental model is "where is my work?"; the UI answers "here are four things you don't have yet."

Second failure: the archive **detail** view leads with `Type / Original ID / Preservation hash` in the KV, then dumps `JSON.stringify(data)`. That's an integrity console, not a research reader. The record's *label* isn't even the heading — the heading is the generic "Record details."

Third: density and hierarchy. Sidebar section labels at 10.5px, link labels at 13.5px, ~18 rows always expanded, four uppercase panel titles at 11px (`--text-xs`) — everything whispers at the same volume, so nothing has priority.

## Prioritized second pass

### P0 — Make imported research the front door (this fixes "horrible")

1. **`navigation.ts`:** remap `'legacy-history': 'research'` (or give it its own `previous` section ordered second, right after `research`). Relabel via existing `SECTION_LABELS`. During migration this is primary content; "Activity, bottom" is wrong.
2. **`overview.tsx`:** make Overview content-aware, not slot-fixed. When native panels have `data && data.length === 0` while the archive row reports a nonzero `status.count`, promote `ArchivePanel` to the top of `ov-main` and collapse the empty native panels into **one** compact "Getting started" card listing them as single lines ("Experiments — none yet · create from a research question"). Purely client-side reordering on data you already fetch; no backend change.
3. **Make `ArchivePanel` real.** It currently renders static prose. Call the existing `ui.read` with `{ rowId: row.id, params: { action: 'summary' } }` (same tool `History` uses — no new dependency) and render the counts as scannable links: "Experiments 142 · Results 380 · Artifacts 96", each linking to `row.path`. Keep the one-line "read-only, cannot be resumed" disclaimer; drop the second `faint` paragraph.
4. **`legacy-history.tsx` default type:** replace the hardcoded `'experiments'` fallback in `restoreNavigation` with the largest-count type from summary (or first available) so the landing list is never empty when the project has other record types.

### P1 — Archive detail: research first, integrity behind `<details>`

Restructure `Detail` top-to-bottom:

1. **Heading = `detail.data.label`** (fall back to id), not "Record details." Type + original status as a `StatusPill` cluster beneath it.
2. **Render known research fields as prose/KV before any JSON.** You already know the domain shapes; pick a small allowlist per type (e.g., `name/title`, `description`, `hypothesis`, `results`, `conclusion`, `status`, `createdAt`) and render string values as readable paragraphs (`overflow-wrap`, normal body font). Generic rule for unknown types: render top-level string/number/date fields as a KV; skip nested objects.
3. **Attached files and `fileRetention` link stay high** — they're the payoff. Keep "Open imported file" as the first action.
4. **Move behind `<details>` (collapsed):**
   - `Preservation hash`, `Original ID` → `<details>` "Provenance & integrity"
   - Full `JSON.stringify(data)` → `<details>` "Raw imported record" (keep the existing `.doc` pre inside it)
   - The "not verified" caveat for artifacts → one `faint` line inside provenance, not top-level.
5. Keep the "read-only" sentence, but as one line under the heading, not after the JSON where nobody reads it.

### P1 — Archive list readability

- The record label is a `btn--sm` (11px button). Make it a normal-weight link/button styled like `ov-item-title` (13.5px, weight 540), and demote `ObjId` to a `title` attribute or remove from the cell — the mono id under every row doubles visual noise for zero navigation value.
- Widen the Created column format to date-only (`toLocaleDateString`) — full timestamps belong in detail.
- Keep the existing top-of-page "cannot be continued" card but shrink it to a single `faint` line under `PageHeader`'s summary; a full `card` for a disclaimer outweighs the actual data.

### P2 — Sidebar hierarchy & sizing

- **Collapsible sections** with persisted open state (`localStorage`, keyed per section id). Defaults: Research + Work open; Operations + Activity collapsed. 18 always-visible links is the "infrastructure console" feel.
- Sizes: `.sidebar-section` 10.5px → **11px**, letter-spacing 0.12em → 0.08em; `.sidebar-link` font 13.5px → **14px**, padding 6px → **7px 10px**. Small changes, big legibility gain; no layout risk.
- Keep counts (`sidebar-link-count`) — they're doing real work, especially on the archive row.

### P2 — Overview visual hierarchy

- Panel titles: `section-title` at 11px uppercase makes every card equal and quiet. Give `ov-panel` heads a proper title (`--text-md`, weight 600, sentence case) and reserve the uppercase micro-style for the `ov-meta` suffix. One CSS class, no restructuring.
- `ResearchPanel` (or promoted `ArchivePanel` per P0) is the primary object; everything in `ov-side` should read one visual step down — it already does structurally, just needs the title-size differentiation to show it.

### Explicitly not doing

No drag-to-customize dashboard, no animation work, no new endpoints or agent tools, no attempt to make archived records "resumable" (correct that they can't be — the disclaimer stays, just quieter). Plugin-conditional rendering (`find(kind)`, `row.readable` guards) is right; keep it.

**Verification order:** P0.2/P0.3 (Overview shows archive counts first on a fresh migrated project) → P1 detail (label heading, JSON collapsed) → sidebar defaults. Each is independently shippable and testable against the existing `ui.read` contract.

~460 words of changes against 3 files + CSS; no redesign theater.