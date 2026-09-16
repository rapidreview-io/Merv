# Merv UI design — "the lab notebook"

The browser UI is a research lab's notebook, not an admin console. A person opens it to answer three questions in this order: what needs me, what is running, what has been recorded. Everything else is configuration and stays out of the way until asked for.

This document is the contract for the 2026-09-16 redesign. `docs/UI_PLUGIN.md` still describes the plugin mechanics (rows, `ui.shell`, `ui.read`); nothing here changes those.

## Principles

1. **Few places.** The left rail lists places, not records. Four sections plus the project and Settings. Rows registered by plugins are reached from within their section, never from the rail.
2. **One thing to look at first.** Every page has a single dominant element: the title line. Secondary navigation sits inside that line; counts and status sit beside the labels they qualify. Nothing competes with the title.
3. **No chrome in normal use.** No section headers, disclosure triangles, refresh buttons, explanatory paragraphs under titles, eyebrow ids, or card borders around lists. Explanations live in empty states, where they help. Creation forms and heavy tables are collapsed behind one control.
4. **Configuration stays possible.** Settings keeps the plugin table, the session block and the introduction editor. Row pages keep their filters and forms. They are folded, not removed.
5. **Personality comes from structure, colour semantics and voice, not decoration or display type.** One clean sans throughout (the founder rejected the serif/typewritten direction on 2026-09-16); every record kind has one colour and one icon used consistently in the rail, the title line, cards and legends; mono only for identifiers. Copy is plain, short and written by a colleague, not a system.

## The rail

Width 224px, same background as the page, one soft line on the right. From top to bottom:

| Row      | What it is                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wordmark | `merv` in the sans at 15px/600, with the hide-sidebar button at the right.                                                                                                                                                                                                                                                                                                                                    |
| project  | The project name in the sans, 15px/600. It is the link to the Overview (`/`). Accounts that may switch projects get a small switch icon that appears on hover and focus (always visible under 880px); it opens the existing project chooser.                                                                                                                                                                  |
| sections | One row per navigation section, in `SECTION_ORDER`: Research, Work, Agents, Feed, each with its section colour as an 8px dot before the label (the legend of the app). Each links to the first registered row of that section and is active when the current path belongs to any row in it. No counts. A dot appears only when a row in the section is degraded or unavailable, with the detail as its title. |
| foot     | Settings rows (group `settings`), then the account row (avatar, name, menu with theme, machine keys, sign out).                                                                                                                                                                                                                                                                                               |

The active section is marked by a 2px accent bar at the left edge of the row and ink-coloured text; inactive rows are muted. Hover is a faint accent wash. `⌘B` and the edge button still hide and show the rail. A section with no registered rows does not appear; if no plugin registers any row the rail shows only the project and Settings.

Section labels: `research → Research`, `work → Work`, `operations → Agents`, `activity → Feed`. Unknown groups keep their humanised label after the known four.

## The title line

On a row's index route (`pathname === row.path`) the shell renders the page header. Views do not render their own title on index routes.

```
RESEARCH                                   ← eyebrow: section label, 11px, letter-spaced, muted
Tasks · Experiments 2 · Reviews · Reflections    ← sans 22px/600; active row in ink, siblings muted links at 22px/500; counts 13px beside their label
```

Siblings are the other registered rows of the same section, in row order. A section with one row shows just the title. The overview (`/`) uses the same grammar with the project name as its title and the introduction's first line beneath it. Detail routes (`/tasks/wf_…`) keep the view's own back link and record title at 22px/600, with the record's kind label above it.

Row-level actions (a "New cycle" button, a filter) render below the title line, right-aligned, at most one primary and one secondary control. Lists refresh themselves; there are no refresh buttons.

## Visual language (reference: problemma.ai canvas, 2026-09-16)

- **Type:** one sans, the system stack (`-apple-system, Inter, Segoe UI, Roboto, Helvetica, Arial`), 14px body, 13px meta, 11px uppercase labels with 0.06em tracking. Headings 22px/600, section headings 15px/600. No display face, no italics for emphasis, no serif anywhere. Mono only for ids and machine text. Numbers tabular.
- **Ground and surfaces:** page ground `#f7f8fa` (dark: `#111214`); records and panels are white surfaces `#ffffff` (dark: `#1a1b1e`) with a 1px `#e5e7eb` border (dark `#2a2b30`), 8px radius and a 1px shadow `0 1px 2px rgba(16,24,40,.04)`. Ink `#111827` / muted `#6b7280` / faint `#9ca3af` (dark: `#e5e7eb` / `#a1a1aa` / `#71717a`).
- **Kind colours** (one per record kind, used for the rail dot, the card's 3px left edge, the uppercase kind label and its icon): research cycles and claims purple `#6d28d9`; papers and records blue `#2563eb`; tasks and experiments teal `#0d9488`; reviews and reflections red `#dc2626`; proposals and consolidation amber `#d97706`; agents, sessions, people and code slate `#475569`; feed and artifacts gray `#6b7280`. Sections take the colour of their first kind: Research purple, Work teal, Agents slate, Feed gray. Semantic greens/ambers/reds for state stay as they are.
- **Record card:** a white surface with the kind edge; first line the uppercase kind label with its icon in the kind colour; then the title 14px/600 ink; then one or two lines of 13px muted; a footer line with the state dot and state word in 11px uppercase. Lists are stacks of cards with 8px gaps on the ground, or, for tables, one white surface holding a plain ruled table.
- **Accent:** `#2563eb` for the one primary control on a page, links on hover and focus rings; the active rail row is marked by its section colour, not the accent.
- **Chrome stays minimal:** the rail, one title line, one action row, then content. No canvas, no minimap, no legend panel unless a page is a graph.

## Pages

- **Overview**: project name, one-line introduction, then three stacked blocks in fixed order: _Needs you_, _In motion_, _Recorded_. Plain lists, no cards. A block mounts only while its owning row is registered. (Phase B.)
- **Index pages**: title line, optional action row, then the list or table. Empty states (heading 15px/600) carry the one-sentence explanation that used to sit under the title. Creation forms open from a single button and close after success.
- **Detail pages**: back link, kind label, record title, status beside it, then sections in reading order. Unchanged in structure.
- **Settings**: introduction editor first, then the session block, then the plugin table inside a collapsed disclosure whose summary reads `Plugins · N active`.

## Where design effort goes

Minimal everywhere buys the right to be deliberate in four places. A 2026-09-16 design panel (four proposing lenses, three verifying judges scoring value, simplicity of use, feasibility and personality against the code and seeded data) ranked the candidates; these four won, in this order.

1. **The standing line (Overview).** One ordered list of what is not moving and whose move it is. Each line is a record card: kind label, the record name, the server's own instruction verbatim beneath it, and a relative time. The order is policy and must stay small: a line is _yours_ when the blocker is `input_required` on a record whose producer is the signed-in actor, or when a review is unclaimed or claimed by you and still open; it is _an agent's_ when the blocker is a role restriction such as `forbidden`; it is _nobody's_ when the blocker is `dependencies_pending`. An unknown blocker code falls through to a neutral waiting line carrying the server's text; it is never promoted to "needs you". Tasks ship guidance inline in `task.list`; experiments and cycles use `workflow.status_and_next`, capped to the most recent eight. Dependency names come from `dependencies[].name`, never from the kind.
2. **The verdict page (`/reviews/:id`).** A criterion row reads as a sentence: the criterion, the producer's confirmation for the same check, the reviewer's finding, and the cited evidence readable in place. Controls come from `workflow.status_and_next` actions (`start_review` ready, `submit_review` blocked with the server's reason), never from browser-side rules. One primary control states its consequence in plain words. It replaces `ReviewCard` and the findings table wherever they appear.
3. **The feed as one narrative column.** Posts are paragraphs in their author's voice; a state change is one quiet line; anything a line is about is a name you can click. Activity folds into it: verdicts, state changes and agents joining earn a line, `artifact.created` and `feed.posted` never appear. The Activity row goes away.
4. **Claims beside what tests them.** The statement is the dominant element at 16px/600; the standing sits beneath; each testing experiment reduces to one plain sentence found by inverting `experiment.testedClaimIds`. `review.claimId` is a review lease, not a research claim, and is never joined. The tension between a human-set standing and machine evidence is shown, not resolved.

Deferred: the experiment record as an attempt spine (every experiment has one attempt today), the sessions floor, pending proposals in the paper.

## Phases

- **A — shell**: rail, title line, fonts, tokens, Settings folding, removal of per-view index titles and refresh buttons.
- **B — overview**: the three-block composition, with _Needs you_ built as the standing line above.
- **C — views**: folded creation forms, quieter filters, empty-state copy, dead CSS removal.
- **D — signature surfaces**: the verdict page, the narrative feed, the claim book.

Each phase must pass `npm run typecheck:ui`, `npm run test:ui`, `node --import tsx --test tests/ui-navigation.test.ts`, `npm run build:ui` and `npm run format:check`, and must report the net line count of `packages/ui/web` against the phase's starting point.

## Rulings of 2026-09-16 (evening)

1. **Graphs are process graphs.** No agent-authored graph anywhere: the `graph` evidence role, `experiment.graph` as an authored document, reflection graphs and the "Logic graph" section are retired. Any graph the UI shows is derived from records (states, transitions, submissions, reviews, dependencies, claims tested). Imported legacy graph artifacts stay readable as plain files. This ships first.
2. **The map is the home page.** The rail keeps its four sections. Opening a project shows the map (sketch board 13): planes for Workflows, Analytics and Integrations above; the record as an object graph with verb edges and a property card in the middle; Data and Agents & compute below. It gives high-level observability, stats and live data, deliberately not enough to decide anything; the person clicks a component on the map, or a rail row, to see more and act. The standing line (Needs you / In motion / Recorded) becomes the Work landing and a block reachable from the map.
3. **Split pane on desktop.** Above about 1080px a list stays mounted on the left while the selected record opens beside it, addressed by the same URL; below that width the record is the page. This is the one sanctioned exception to "one dominant element".
4. **Build order.** Graph retirement; then the Linear-style onboarding and Settings › Integrations pages and the map home in parallel on disjoint files; then the legacy carry-overs from the old React UI study.
