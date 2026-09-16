# Fable UI overhaul — 2026-09-16

The user requested a first-principles UI overhaul by Fable, loosely inspired by the legacy Python/JavaScript platform, and approved the prepared frontend source packet. Two actual `claude-fable-5` invocations ran with tools, MCP servers and web access disabled. No alternate model was substituted. Hashes and times are recorded in [provenance](ui-overhaul-fable-20260916-provenance.json).

## Contribution and integration

Fable generated the application landing route, sidebar/shell, project Overview, design-system CSS, navigation model and shared presentation components. The first response started midway through a file; four complete files were recovered. A smaller second invocation returned complete navigation/components files and a design explanation. Partial file fragments were not installed.

The design centers project work: current research, work in progress, agents, findings and evidence. It takes the legacy warm background, restrained orange accent, typography and results-first emphasis without importing the old application's stores or components.

Local integration refined the generated navigation to match actual view kinds (`people`, `connections`, etc.), retaining all unknown plugin rows and server-owned routes. It added mobile focus containment, background isolation, Escape/focus restoration, drawer layering, readable secondary text, checkbox sizing, project-introduction refresh and periodic authoritative workflow guidance. The overview's proposed latest-feed preview was replaced by a direct feed link because the existing bounded endpoint returns oldest-first pages. Failed reads do not present cached counts as fresh data.

Parallel local work added shared task/experiment/review filters, evidence-first detail ordering, the Agents/Operations split, current-assignment versus historical tool activity, and clearer project selection. These are local contributions, not claims that Fable authored every final line.

## Review outcome

Independent source review identified five concrete generated-code issues: mobile agent header layering, incorrectly labeled latest feed posts, checkbox styling, stale project introduction and stale guidance following optional-provider removal. All five were addressed before staging. Final navigation review also corrected domain detection to use the registered view kind instead of its row ID.

UI/backend typechecks and builds pass. Focused automated and browser verification is listed in [UI_OVERHAUL.md](../UI_OVERHAUL.md). Fable generated source; it did not perform browser testing or certify production readiness. The integration was browser-tested locally with invented data, then deployed only to the existing private Azure preview with imported-data and access-boundary checks. Public legacy production remains unchanged.

## Remaining limits

The redesign does not add missing product capabilities, writable historical workflows or actual model billing measurements. The bundle still uses one main application chunk; Vite's size warning remains. Native resumption of unfinished imported work and the eventual public cutover remain separate decisions.
