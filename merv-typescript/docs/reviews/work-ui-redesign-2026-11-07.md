# Work page redesign — November 7, 2026

The user asked for a simpler, conventional work-management interface because the canvas did not explain the work or the overall situation. Scope: the main Merv Work page, not the separate freeform Board or the desktop repository.

## Design references

- [Linear Projects](https://linear.app/docs/projects): purpose and project context belong above the individual work; overview, milestones and issue views have distinct roles.
- [Linear Display options](https://linear.app/docs/display-options): readable issue lists group by meaningful properties and show explicit status, ownership and activity. Display properties and filters are distinct.
- [Asana Project overview](https://help.asana.com/s/article/project-overview-tab): communicate purpose, objectives and approach; make the brief and progress accessible alongside tasks.

These are interaction references rather than copied branding. Merv has real workflow stages, reviewers, dependencies, owners and live execution. It does not have general priority or due-date fields in this overview, so the page must not invent those or imply a task count predicts research certainty.

## Implemented hierarchy

1. A compact Work heading and current-cycle link.
2. One toolbar for active/all/history, search and a filter disclosure.
3. Grouped rows with a kind icon, title, exact stage, owner and recent change. Critical attention remains visible; ordinary descriptions and activity do not repeat in the list.
4. Existing inspectors and record pages for descriptions, dependencies, execution details and actions, preserving `?key=` links and history.

The first pass put too much introductory text and too many controls above the work. The user rejected it. The revision removes the purpose paragraph, cycle card, repeated status counters, per-row descriptions, cycle links and activity disclosures. The project brief and cycle actions remain on their existing pages.

Data ownership remains unchanged: Research owns cycle progress and transition gates, domain plugins own records and states, and the running read owns live execution/attention. The browser only joins and presents those existing facts.

Fable collaboration was explicitly requested. The first Claude Code invocation requested model `fable`, read-only repository tools and no fallback; it failed before model execution because the saved OAuth session expired and could not refresh. The user was asked to sign back in. Invocation and output are retained under `/tmp/merv-work-redesign`.

## Validation and result

The Work page uses a conventional grouped list at every width. Search, type/owner/cycle filters, active/all/history views and the existing work inspector remain available. Attention on connected agents or machines remains visible on its work item, including after that item ends. Live-only records survive partial home reads; counts are computed from one filtered catalog.

The unused canvas renderer, layout and legend/filter code were removed. Shared live reads, inspector state and dispatch controls now live in `views/work-live.tsx`; dispatch reuses the existing `Act` command boundary. The production UI changes remove **846 net lines**. No new backend API, workflow rule, database field or dependency was introduced.

- All **23 UI tests** pass, including two generalized Work cases covering count conservation, filters/history, connected attention, live-only records, inspector calls and partial/failed-read recovery. The compact revision updates those same cases rather than increasing the suite. They also check focus restoration from a connected attention icon and that dismissing Filter with Escape leaves an open inspector intact.
- Server and browser typechecks, production UI build, CI formatting and diff whitespace checks pass.
- Browser validation used a real isolated local PostgreSQL demo with simulated workers. The current cycle is illustrative seeded data. At 1440×1000, all **11 active items** fit, compared with four complete rows in the rejected first pass. At 390×844, **10 rows** fit, compared with zero; the first row starts at239px instead of787px, and the document stays390px wide. Checked type filtering, reset, attention details, close/focus and Filter Escape. At1200px with an inspector open, the list occupies588px and its title column317px; metadata collapses without horizontal overflow. Temporary viewport overrides were reset.
- Preview: `http://localhost:5180/ui/work`, backed by the local demo at port3091. Local logs, design request, failed Fable response and screenshots are under `/tmp/merv-work-redesign`.

Fable review remains blocked by Claude Code authentication. The local implementation is ready for review; no deployment was performed.
