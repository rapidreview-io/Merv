# Merv UI design — "the lab notebook"

The browser UI is a research lab's notebook, not an admin console. A person opens it to answer three questions in this order: what needs me, what is running, what has been recorded. Everything else is configuration and stays out of the way until asked for.

This document is the contract for the 2026-09-16 redesign. `docs/UI_PLUGIN.md` still describes the plugin mechanics (rows, `ui.shell`, `ui.read`); nothing here changes those.

## Principles

1. **Few places.** The left rail lists places, not records. Four sections plus the project and Settings. Rows registered by plugins are reached from within their section, never from the rail.
2. **One thing to look at first.** Every page has a single dominant element: the serif title line. Secondary navigation sits inside that line; counts and status sit beside the labels they qualify. Nothing competes with the title.
3. **No chrome in normal use.** No section headers, disclosure triangles, refresh buttons, explanatory paragraphs under titles, eyebrow ids, or card borders around lists. Explanations live in empty states, where they help. Creation forms and heavy tables are collapsed behind one control.
4. **Configuration stays possible.** Settings keeps the plugin table, the session block and the introduction editor. Row pages keep their filters and forms. They are folded, not removed.
5. **Personality comes from type and voice, not decoration.** Instrument Serif for titles, names and large numerals; the system sans for everything else; mono only for identifiers. Copy is plain, short and written by a colleague, not a system.

## The rail

Width 224px, same background as the page, one soft line on the right. From top to bottom:

| Row      | What it is                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wordmark | `merv` in serif italic, with the hide-sidebar button at the right. The only decoration in the rail.                                                                                                                                                                                                                      |
| project  | The project name in serif, 17px. It is the link to the Overview (`/`). Accounts that may switch projects get a small switch icon that appears on hover and focus (always visible under 880px); it opens the existing project chooser.                                                                                    |
| sections | One row per navigation section, in `SECTION_ORDER`: Research, Work, Agents, Feed. Each links to the first registered row of that section and is active when the current path belongs to any row in it. No counts. A dot appears only when a row in the section is degraded or unavailable, with the detail as its title. |
| foot     | Settings rows (group `settings`), then the account row (avatar, name, menu with theme, machine keys, sign out).                                                                                                                                                                                                          |

The active section is marked by a 2px accent bar at the left edge of the row and ink-coloured text; inactive rows are muted. Hover is a faint accent wash. `⌘B` and the edge button still hide and show the rail. A section with no registered rows does not appear; if no plugin registers any row the rail shows only the project and Settings.

Section labels: `research → Research`, `work → Work`, `operations → Agents`, `activity → Feed`. Unknown groups keep their humanised label after the known four.

## The title line

On a row's index route (`pathname === row.path`) the shell renders the page header. Views do not render their own title on index routes.

```
RESEARCH                                   ← eyebrow: section label, 11px, letter-spaced, muted
Tasks · Experiments 2 · Reviews · Reflections    ← serif, 30px; active row in ink, siblings muted links; counts in sans 13px beside their label
```

Siblings are the other registered rows of the same section, in row order. A section with one row shows just the title. The overview (`/`) uses the same grammar with the project name as its title and the introduction's first line beneath it. Detail routes (`/tasks/wf_…`) keep the view's own back link and record title, set in the same serif.

Row-level actions (a "New cycle" button, a filter) render below the title line, right-aligned, at most one primary and one secondary control. Lists refresh themselves; there are no refresh buttons.

## Type and colour

- `Instrument Serif` Regular and Italic, self-hosted as woff2 under `packages/ui/web/fonts/`, declared with `font-display: swap`, fallback `Georgia, 'Times New Roman', serif`. Used through `--font-display`.
- System sans (`--font-body`) for UI at 14–15px; mono (`--font-mono`) for identifiers and machine text only.
- Light theme (default when the OS is light): warm paper `#f5f3ee`, raised `#fdfcfa`, ink `#1b1a17`, muted `#5c5955`, lines `#e6e2da`. Accent `#c9471f`.
- Dark theme: warm near-black `#151412`, raised `#1d1c19`, paper text `#ecebe6`, muted `#a19e97`, lines `#2b2926`. Accent `#ff7a45`.
- Semantic greens/ambers/reds stay as they are. The accent marks the active place, focus rings and the one primary control on a page. It is not used for links at rest.

## Pages

- **Overview**: project name, one-line introduction, then three stacked blocks in fixed order: _Needs you_, _In motion_, _Recorded_. Plain lists, no cards. A block mounts only while its owning row is registered. (Phase B.)
- **Index pages**: title line, optional action row, then the list or table. Empty states carry the one-sentence explanation that used to sit under the title. Creation forms open from a single button and close after success.
- **Detail pages**: back link, serif record title, status beside it, then sections in reading order. Unchanged in structure.
- **Settings**: introduction editor first, then the session block, then the plugin table inside a collapsed disclosure whose summary reads `Plugins · N active`.

## Where design effort goes

Minimal everywhere buys the right to be deliberate in four places. A 2026-09-16 design panel (four proposing lenses, three verifying judges scoring value, simplicity of use, feasibility and personality against the code and seeded data) ranked the candidates; these four won, in this order.

1. **The standing line (Overview).** One ordered list of what is not moving and whose move it is. Each line is the record name in the serif, the server's own instruction verbatim beneath it, and a relative time. The order is policy and must stay small: a line is _yours_ when the blocker is `input_required` on a record whose producer is the signed-in actor, or when a review is unclaimed or claimed by you and still open; it is _an agent's_ when the blocker is a role restriction such as `forbidden`; it is _nobody's_ when the blocker is `dependencies_pending`. An unknown blocker code falls through to a neutral waiting line carrying the server's text; it is never promoted to "needs you". Tasks ship guidance inline in `task.list`; experiments and cycles use `workflow.status_and_next`, capped to the most recent eight. Dependency names come from `dependencies[].name`, never from the kind.
2. **The verdict page (`/reviews/:id`).** A criterion row reads as a sentence: the criterion, the producer's confirmation for the same check, the reviewer's finding, and the cited evidence readable in place. Controls come from `workflow.status_and_next` actions (`start_review` ready, `submit_review` blocked with the server's reason), never from browser-side rules. One primary control states its consequence in plain words. It replaces `ReviewCard` and the findings table wherever they appear.
3. **The feed as one narrative column.** Posts are paragraphs in their author's voice; a state change is one quiet line; anything a line is about is a name you can click. Activity folds into it: verdicts, state changes and agents joining earn a line, `artifact.created` and `feed.posted` never appear. The Activity row goes away.
4. **Claims beside what tests them.** The statement is the dominant element in the serif; the standing sits beneath; each testing experiment reduces to one plain sentence found by inverting `experiment.testedClaimIds`. `review.claimId` is a review lease, not a research claim, and is never joined. The tension between a human-set standing and machine evidence is shown, not resolved.

Deferred: the experiment record as an attempt spine (every experiment has one attempt today), the sessions floor, pending proposals in the paper.

## Phases

- **A — shell**: rail, title line, fonts, tokens, Settings folding, removal of per-view index titles and refresh buttons.
- **B — overview**: the three-block composition, with _Needs you_ built as the standing line above.
- **C — views**: folded creation forms, quieter filters, empty-state copy, dead CSS removal.
- **D — signature surfaces**: the verdict page, the narrative feed, the claim book.

Each phase must pass `npm run typecheck:ui`, `npm run test:ui`, `node --import tsx --test tests/ui-navigation.test.ts`, `npm run build:ui` and `npm run format:check`, and must report the net line count of `packages/ui/web` against the phase's starting point.
