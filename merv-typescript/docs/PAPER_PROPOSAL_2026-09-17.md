# The paper page: design study and proposal (2026-09-17)

Read-only study commissioned after the founder ruled "Paper needs to look beautiful and functional." Nothing here changed code; the sketch is board 15 on the design canvas.

---

# The paper page — "beautiful and functional"

A read-only design study for `/paper`, written against `merv-typescript/docs/UI_DESIGN.md` (the lab-notebook contract,
its Tinker chrome ruling, the no-identifiers ruling, the icons-only-in-the-rail ruling, the verb table and the wave-1/2
anatomies), `docs/UI_REFERENCES.md`, `docs/UI_TRANSLATION_2026-09-16.md`, and the paper plugin as it actually is
(`packages/paper/src/{index,types,models,tools,input}.ts`, `docs/LIVING_PAPER.md`).

Founder ruling being answered (`docs/UI_DESIGN.md`, rail rulings of 2026-09-17): **"Paper must look beautiful and
functional."**

Nothing here changes the plugin. Every rule below is expressible with `paper.read`, `paper.patch`, `paper.cite` and the
lists the browser already reads.

---

## 0. References read, and what each one contributed

Screenshots of all seven are beside this file in `refs/` (captured with a scratchpad copy of `dev_docs/inspo_shot.mjs`,
1440 wide, clipped to 2600px).

| Reference                                                                                                                     | What it contributed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **arXiv HTML** (`arxiv.org/html/2404.19756v1`, `refs/arxiv-html.png`)                                                         | The sticky **outline in the left gutter** carrying the numbered section tree (`1 Introduction`, `2 Kolmogorov–Arnold Networks (KAN)`, `2.1 …`), with `Abstract` and `References` unnumbered; a **single centred reading column** of roughly 620px inside a 1440 viewport; **bracketed numeric citations as links** (`[1, 2, 3]`, `[6, 7]`); cross-references that are themselves links (`illustrated in Figure 0.1`); the figure **centred with its caption below**: "Figure 0.1: Multi-Layer Perceptrons (MLPs) vs. Kolmogorov-Arnold Networks (KANs)". Taken: the gutter outline, the numbered address, the bracketed marker, the caption-below rule. Left: justification, the serif, the two-line author block.                                                                                                                                                                                                                                                                                                        |
| **Distill** (`distill.pub/2020/circuits/zoom-in/`, `refs/distill-article.png`)                                                | The **byline strip** as small uppercase grey labels over their values — `AUTHORS` / `AFFILIATIONS` / `PUBLISHED` / `DOI` — ruled off above and below by a hairline; a `Contents` outline in the gutter with nested, indented entries; body set **ragged-right, not justified**, ~17px on ~1.7 line height at ~62–66 characters; figures **breaking out of the column to the left** with the caption in small grey type underneath, the caption itself carrying a citation marker; and the guide's own layout vocabulary — `.l-body`, `.l-middle` ("For images you want to display a little larger"), `.l-page`, `.l-screen` ("Occasionally you'll want to use the full browser width"), `.l-gutter` for "marginalia, asides, and footnotes", each with an `outset` variant "if you want to poke out from the body text a little bit"; citations are "a number that displays more information on hover". Taken: ragged-right measure, the labelled meta strip, the gutter, one breakout step for figures, hover-to-source. |
| **Overleaf** (`overleaf.com/about/why-latex`, `docs.overleaf.com/collaborating/track-changes`, `refs/overleaf-why-latex.png`) | The editing contract stated plainly: "No more email feedback and endless versions of documents. Instead, get comments, sharing, real-time track changes, and document history directly in your LaTeX project"; and the review gesture: after selecting text containing changes, "the option to **Accept selected changes** or **Reject selected changes** will appear." Taken: history and proposed changes belong _in_ the document, not in a separate place. Left: the accept/reject controls — in Merv a paper change is accepted by a **review**, never by a reader clicking accept, and the browser must not grow that verb.                                                                                                                                                                                                                                                                                                                                                                                         |
| **Typst** (`typst.app/docs/tutorial/formatting/`, `refs/typst-formatting.png`)                                                | Typesetting as a small set of named parameters with concrete values — `#set page(margin: (x: 1.8cm, y: 1.5cm))`, `#set text(font: "New Computer Modern", size: 10pt)`, `#set par(leading: 0.52em)`, `#set par(justify: true)`, `#set heading(numbering: "1.")`, with "1em is equivalent to the current font size". Taken: state the paper's type as a handful of explicit values (below), and derive heading numbers rather than storing them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Notion** (`notion.com/product/docs`, `refs/notion-docs.png`)                                                                | The outline promise in one sentence — "Click to jump to a section. Updates automatically." — and the suggestion model, "Allow others to comment or suggest edits", with "A consolidated view of feedback makes it easy to iterate". Taken: the outline is derived and always current; a suggestion is visible in place. Left: blocks, emoji headers, the sidebar-as-workspace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Semantic Reader** (`semanticscholar.org/product/semantic-reader`, `refs/semantic-reader.png`)                               | The citation affordance done properly: "Citations Cards that show details of a cited paper in-line where you're reading, including TLDR summaries", plus "Table of Contents to quickly navigate between sections", and citations "visually augmented based on their connections to your research activities". The screenshot shows bracketed numbers in the margin of a column with one hover card open carrying title, authors and date. Taken: hover a marker, get a card with authors/year/title — never a raw identifier. Left: AI highlight overlays and the library badges; Merv's equivalent augmentation is _whether this project retained evidence for the citation_.                                                                                                                                                                                                                                                                                                                                            |
| **Elicit** (`elicit.com`, `refs/elicit-home.png`)                                                                             | The claim-to-source principle: Elicit "supports all AI-generated claims with sentence-level citations from the underlying sources" and calls the result "reproducible, traceable, and auditable at every step". Taken: every sentence that asserts something must be one click from what backs it. Left: the whole skin — the home page is a serif display marketing page, and the founder withdrew the serif on 2026-09-16.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Two working conclusions from the set:

1. Every reference that reads well is **one column, ragged-right, 60–70 characters, with an outline in the gutter**.
   None of them puts the document inside a card.
2. Every reference that handles sources well **lets the marker stay tiny and puts the detail one hover away**. None of
   them prints an identifier as the citation's name.

---

## 1. What the paper page must do

Grounded in `paper.read` / `paper.patch` / `paper.cite` and nothing else.

**The record.** `paper.read` returns one `PaperWorkspace`: four documents keyed `problem | literature | methods |
results`, a flat `citations` ledger, and `proposals`. Each document is `{ current: PaperRevision, published:
{ publication, document } | null }`. A revision is an ordered list of `{ id, title, content }` sections plus
`updatedBy`, `updatedAt` and, when it came from a proposal, `proposalId`.

| #   | The page must…                                      | What it reads / calls                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Read the current document by sections**           | `documents[kind].current.sections` in stored order. Problem's four are fixed keys in fixed order (`problem, scope, goals, constraints`); Literature, Methods and Results are free-ordered.                                                                                       |
| 2   | **Show the published version against the current**  | `documents[kind].published` is a publication plus the exact revision it published. When `published.document.revision < current.revision` the paper is ahead of what passed review, and the page must say so.                                                                     |
| 3   | **Show proposed edits against the published text**  | `proposals[]` with `acceptance === null`. Each carries `documents[].before` (the pinned revision) and `documents[].edit.changes` (`{id, title?, content?, afterId?, remove?}`), so a real diff is computable here.                                                               |
| 4   | **Name which experiment or reflection proposed it** | `proposal.source = { kind: 'experiment' \| 'reflection', id, revision }`. The **name** comes from `experiment.list` / `reflection.list`; a source the page cannot name is omitted, never printed as its id.                                                                      |
| 5   | **Name which review accepted it**                   | `proposal.acceptance = { reviewId, reviewerId, publications }` and `publication.reviewId`. Named through `review.list` + actor names; linked to `/reviews/:id`.                                                                                                                  |
| 6   | **Edit a section**                                  | `paper.patch { kind, expectedRevision, requestId, changes:[{id,title,content}] }` — **Problem and Literature only**. Methods and Results refuse with `paper_review_required`.                                                                                                    |
| 7   | **Add or move or remove a section**                 | the same patch: `afterId: null` to the top, `afterId: <id>` below one, `remove: true` for an unreferenced one. Problem forbids all three.                                                                                                                                        |
| 8   | **Add and edit a citation**                         | `paper.cite { id?, expectedRevision, requestId, identifier, title, authors[], year, url, notes, sectionIds[], refs[] }`. `refs` are project `artifact:<id>` evidence; `expectedRevision` is 0 for a new entry.                                                                   |
| 9   | **Show the citation ledger and what it points at**  | `citations[]`, each with `sectionIds` (literature sections) and `refs` (retained files). The ledger is the paper's References section, not a table of strings.                                                                                                                   |
| 10  | **Show the revision history**                       | `paper.read { kind, history: true }` → every retained `PaperRevision` for that document, with `updatedBy`, `updatedAt`, and `proposalId` when a review published it.                                                                                                             |
| 11  | **Show the evidence a published claim rests on**    | `publication.evidence[] = {id, hash}` and `citation.refs[]` — both artifact references, both readable in place through the shared `Evidence` component.                                                                                                                          |
| 12  | **Refuse honestly**                                 | `paper_revision_conflict` ("The document changed; prepare and review a new proposal against its current revision"), `paper_section_referenced`, `paper_too_large` (100 sections / 160,000 characters), `paper_citation_exists`. Each is the server's sentence, printed verbatim. |

**What the page must _not_ do.** There is no `paper.propose` and no `paper.accept` tool: both are trusted in-process
owner APIs called inside an experiment's or reflection's submission and its review transaction. So the browser has
**no accept, no reject, no publish and no submit control on this page, ever**. A pending proposal is read here and
decided elsewhere; the only thing the page may offer is the way to the record that decides it.

**A reader who is not the author** (role `reader`/`reviewer`, or any agent session — `paper.patch` refuses
`caller.session`) needs, with no controls at all:

- which text has passed review and which has not, per section, without hunting;
- what changed since the last publication, and on whose submission;
- the source behind any assertion: the citation card, the retained file, the experiment;
- a stable address for a section, so it can be quoted in a review or a feed post
  (`/paper/results#baseline-reproduction` — a fragment, never a visible identifier);
- the published-only reading of the whole paper, in one toggle.

---

## 2. The beautiful part — concrete rules inside the existing contract

All values are the tokens already in `packages/ui/web/styles.css`. The paper introduces **no new colour and no new
font**; it introduces exactly three new custom properties (`--measure`, `--outline-w`, `--paper-lh`) and one new kind
colour usage (the amber already assigned to proposals).

### 2.1 The reading column

| Property         | Value                                                  | Why                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Family           | `--font-body` (the system sans)                        | The serif was withdrawn 2026-09-16. One sans throughout.                                                                                                                           |
| Body size        | **15px** (`--text-md`), not 14px                       | The one page in the app read for minutes rather than scanned. 15px is already a token; nothing new is invented.                                                                    |
| Line height      | **1.7** (`--paper-lh`)                                 | Against the app's 1.55. Distill sits near 1.7 at a comparable measure; a 1.55 paragraph at 15px reads as a table cell.                                                             |
| Measure          | **68ch** (`--measure`), the app's existing `p` cap     | ≈62–66 characters in the system sans — the arXiv/Distill band. The cap is already in the stylesheet; the paper reuses it rather than declaring a second one.                       |
| Alignment        | Ragged right, no hyphenation                           | Distill and every screen reference; arXiv's justification is a print artefact.                                                                                                     |
| Paragraph rhythm | No indent; `margin-top: var(--space-3)` between `<p>`s | A section's `content` is split on blank lines into real paragraphs; single newlines stay `<br>`. Today's `.prose { white-space: pre-wrap }` double-spaces authored text — dropped. |
| Colour           | `--text` on `--bg` (the page ground)                   | No card. The document is not a box; the Tinker ruling applies with no carve-out.                                                                                                   |
| Numbers          | `font-variant-numeric: tabular-nums` inside the column | Step counts and accuracies line up between paragraphs.                                                                                                                             |

### 2.2 Heading hierarchy

Nothing on the page is larger than the app's `--text-xl` (22px). Depth is carried by weight, colour and a derived
number, in the Typst spirit of `#set heading(numbering: "1.")`.

| Level                        | Type                                                                                               | Number                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Page title (`h1`)            | 22px/600 — the word **Paper**, with `PAPER` as the kind label above it in the paper blue `#2563eb` | none                                                                        |
| Document (`h2`)              | **16px/600** (`--text-lg`), `--text`, 32px of air above                                            | **derived** `1–4` in `--faint` tabular, hanging left of the heading         |
| Section (`h3`)               | **15px/600** (`--text-md`), `--text`, 20px above                                                   | **derived** `1.1`, `1.2` … in `--faint` tabular, hanging in the same column |
| Block label inside a section | 11px/600 uppercase, `0.06em` tracking, `--faint` (`.label`)                                        | none — `PROPOSED`, `FIGURE 2`, `REFERENCES`                                 |

Numbers are computed from order at render time and never stored: they change when a section moves, which is correct,
and they give the outline and the body one shared address. The document names are the plugin's own, humanised once:
**Problem & scope · Literature · Methods · Results**.

### 2.3 Citations

The plugin's citation edge is `citation.sectionIds` — a citation names the _literature sections_ it belongs to. There
are no inline markers inside the stored text and the UI must not pretend otherwise.

- **Numbering.** The ledger is numbered `[1] … [n]` in the order `paper.read` returns it (the server sorts by
  `identifier, id`, so the order is stable across reads and across sessions). A number means the same entry everywhere
  on the page.
- **Inline.** Each literature section ends with a quiet run of its own markers — `[2] [5] [7]` — at 13px in `--muted`,
  set on one line under the last paragraph with no label. That is the honest rendering of `sectionIds`: these are the
  works this section rests on.
- **Hover.** A marker is a `<button>`; hover or focus opens a card (the one hairline box the palette pattern already
  permits) carrying **authors · year** on the first line, the **title** on the second, `notes` on the third if present,
  and the count of retained files. Distill: "a number that displays more information on hover"; Semantic Reader:
  "Citations Cards that show details of a cited paper in-line where you're reading".
- **Click.** Scrolls to the ledger entry and focuses it.
- **Never an id.** The visible name of a citation is `Authors · Year · Title`. The DOI/arXiv string is a _bibliographic_
  identifier, not a Merv identifier, so it survives — as one 11px mono line inside the opened entry, and as the `href`
  when `url` is null (`https://doi.org/…`, `https://arxiv.org/abs/…`). No `citation_…`, `art_…` or `paperpub_…` string
  appears anywhere. Today's page prints `item.identifier` as the entry's third line and `Accepted by review
${reviewId}` as prose; both go.
- **The ledger** is the last block of the Literature document, headed `REFERENCES`, built as the app's one list
  anatomy: rows on the ground divided by hairlines, at most two lines.
  - line 1 — `[7]` in `--faint` tabular, then **Authors · Year · Title** (authors elided to `Power et al.` past three);
  - line 2 — the standing: `Cited in Prior work, Setup · 2 retained files · updated 3d ago`.
  - The row is a `<details>`: opening it shows `notes` as prose, the mono identifier line, and each `refs` entry through
    the shared `Evidence` component, so a retained file **opens inside the ledger** and costs nothing until opened
    (the fix `docs/UI_TRANSLATION_2026-09-16.md` line 72 already demands: "the paper citation ledger, which dumps raw
    ref strings as mono text with no way to read any of it").
  - An entry no section names reads `Not cited in any section` in `--faint` — a fact that could exist and does not.

### 2.4 Figures and tables from retained files

Merv artifacts are immutable text and JSON; `ArtifactBody` renders UTF-8 in `<pre class="doc">` and anything else as
"Binary file". **So the page must not design image plates that cannot exist.** A figure here is a retained file read in
place:

- A **figure block** sits in the reading column at the full measure, ruled off above by a hairline, and is
  `FIGURE n` (11px uppercase `--faint`) + the file's **title** as the caption line at 13px `--text`, then the body
  opened in place. Caption below the body, per arXiv ("Figure 0.1: …") and Distill.
- Numbering `n` is derived from order of appearance within the document, like the headings.
- **Where a figure comes from:** the `publication.evidence[]` pinned by the publication that published this section,
  and `citation.refs[]` for a citation cited in it. Nothing else. A file the page cannot name is omitted.
- **Breakout.** One step only, Distill's `l-body-outset`: a figure may exceed the 68ch measure up to
  `min(100%, 92ch)`; tables may take the full content width inside their own `overflow-x: auto`. Body text never
  changes width.
- **Tables.** A `text/csv` or `text/tab-separated-values` file renders through the app's plain ruled `Table` instead of
  `<pre>` — same hairlines as everywhere else. This is the one change outside `views/paper.tsx` and it is optional
  (see §5).

### 2.5 The proposed edit against the published text — a quiet diff

`proposal.documents[].before` is the full pinned revision and `edit.changes[].content` is the whole new section body,
so a word-level diff is exact, not guessed.

- The section renders **once**, as the published text carrying marks — not two stacked copies, not side-by-side panes.
- **Insertion:** ink `--text`, with `text-decoration: underline`, `text-decoration-color: #d97706`,
  `text-decoration-thickness: 2px`, `text-underline-offset: 3px`. Amber is already the kind colour for _proposals and
  consolidation_; nothing new enters the palette.
- **Deletion:** `--faint` with `text-decoration: line-through` in the same `--faint`. Struck text is quiet, never red.
- **No background fill, no box, no gutter bar, no left edge** (the founder's 2026-09-17 ruling), no green.
- **A new section** proposed by the edit appears in place, in its proposed position, with its whole body underlined and
  the heading marked `PROPOSED`; a **removed** section stays in place, struck, with the label `PROPOSED REMOVAL`.
- **The attribution line**, directly under the section heading, 13px `--muted`, one sentence:
  `Proposed by Sweep weight decay 0.1–3.0 · waiting on its review` — the experiment is a link to
  `/experiments/:id`, the review a link to `/reviews/:id`. When it is accepted the same line reads
  `Published from Baseline p=97 reproduction · accepted by Maya Osei's review · 6d ago`.
- **The toggle** is one `.btn-text` on the section: `Show published version` / `Show proposed changes`. It is
  deliberately not a verb — the verb table lists `Show published version` among the labels that carry no verb because
  they only change what is displayed.
- **When a section has no proposal**, it carries no marks and no toggle. Nothing is drawn to say a section is unchanged.
- **The paper-level statement** lives once in the title line's summary, as the app's `ThreeStates` clause line:
  `● PUBLISHED · Results at revision 4, Methods at revision 3 · 1 change waiting on review · updated 6d ago`.

### 2.5a Attribution — which line belongs to the document and which to the section

A revision is per **document**; a change is per **section**. The page must not blur them.

- `updatedBy` / `updatedAt` belong to the whole revision, so for **Problem & scope** and **Literature** — the two
  documents `paper.patch` moves — the attribution is one line under the _document_ heading:
  `Edited by Ada Whitfield · 12d ago · never reviewed`. The last clause matters: a `paper.patch` edit passed no
  review and the page must never let it read as though it had.
- For **Methods** and **Results**, `proposal.documents[].edit.changes[].id` names the exact sections a proposal
  touched, so the attribution is per _section_:
  `Published from Baseline p=97 reproduction · accepted by Maya Osei's review · 6d ago`.
- A section that the most recent publication did not touch is attributed by walking the document's retained
  revisions back to the last one whose proposal changed that section id. That needs
  `paper.read { kind, history: true }`; **until that read lands the line is omitted, never guessed**.

### 2.6 Navigation — the outline

An arXiv/Distill gutter outline, sticky, **inside** the page.

- **Left column, `--outline-w: 196px`**, separated from the reading column by a single hairline `--line` and 32px of
  gap. A hairline between two panes is a divider, which the contract allows; it is not a left edge on a card.
- Contents: the four documents in fixed order, each with its derived number and its sections nested one 12px indent
  below. Distill's `Contents`; Notion's "Click to jump to a section. Updates automatically."
- The current entry is **ink and 600 weight**; every other entry is `--muted`. No pill, no bar, no dot — the rail owns
  the pill.
- A section with an open proposal carries a 5px amber dot after its name (the proposals kind colour, the same dot
  geometry as `.status-dot`); nothing else is decorated.
- `position: sticky; top: 0; max-height: 100vh; overflow-y: auto` — the same shape `.split-list` already uses.
- **Responsive.** Below 1080px the outline becomes a single wrapped row of the four document names above the column.
  Below 760px it disappears; the headings are the navigation. The page never scrolls horizontally.
- The rail's `Paper` row stays the only icon in sight; the outline is text.
- `/paper/:kind` keeps working as a deep link that opens the paper scrolled to that document, and
  `/paper/:kind#<section>` to a section — routes carry identifiers, pages never print them.

### 2.7 Type scale, in one table

| Element                | Size / weight / colour                     |
| ---------------------- | ------------------------------------------ |
| Kind label `PAPER`     | 11px/600, `0.06em`, `#2563eb`              |
| Page title             | 22px/600, `--text`                         |
| Standing line          | 13px, `--muted`, verdict word coloured     |
| Document heading       | 16px/600, `--text`                         |
| Section heading        | 15px/600, `--text`                         |
| Derived number         | 15px/400 tabular, `--faint`                |
| Body paragraph         | 15px/1.7, `--text`, max 68ch               |
| Attribution / caption  | 13px, `--muted`                            |
| Citation marker        | 13px tabular, `--muted`; `--text` on hover |
| Ledger line 1          | 15px, `--text`; the `[n]` 13px `--faint`   |
| Ledger line 2          | 13px, `--muted`                            |
| Block label            | 11px/600 uppercase `0.06em`, `--faint`     |
| Section-title (`Part`) | 15px/600, `--text` — unchanged             |

### 2.8 Dark theme

Everything above is token-driven and inherits. Three statements are explicit:

1. The reading column stays on `--bg` (`#111214`), never on `--bg-elev`; there is no card to darken.
2. The amber insertion underline lifts to `#d4a045` (`--qualifies` dark) so it survives on the dark ground; the
   deletion strike stays `--faint` (`#71717a`).
3. The citation hover card is the one box: `--bg-elev` with a 1px `--line` and `--shadow-md`, exactly as the palette
   draws itself.

No colour is defined only inside a dark block; the light palette is complete on its own.

---

## 3. The record anatomy mapping

`/paper` is **one record page** (`RecordPage`), not a collection of four. The four documents are parts of one paper,
the way Methods and Results are parts of one paper everywhere else in science.

### What happens next (`act`) — controls only, from the verb table

Rendered only when the caller may write (`actor.role` is `operator` or `producer`; agent sessions are refused by the
service). For a reader the slot is dropped entirely rather than drawn empty.

| Control                     | Tool          | Condition                                                                           |
| --------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `Edit Problem`              | `paper.patch` | always (fixed key)                                                                  |
| `Edit Scope`                | `paper.patch` | always                                                                              |
| `Edit Goals`                | `paper.patch` | always                                                                              |
| `Edit Constraints`          | `paper.patch` | always                                                                              |
| `Edit <literature section>` | `paper.patch` | one per literature section                                                          |
| `New section`               | `paper.patch` | Literature only — Problem's four keys are fixed and Methods/Results refuse          |
| `New citation`              | `paper.cite`  | always                                                                              |
| `Edit citation`             | `paper.cite`  | when the ledger is non-empty — **one** control; the entry is chosen inside the form |

The verb table spells `Edit <section name>` with the name and `Edit citation` without one, which is exactly the right
split: sections are structural and bounded, citations are a list and must not become a wall of buttons. Today's page
emits one `Edit {citation.title}` button **per citation**; that is the rule being broken.

There is **no primary control**. Nothing on a paper is the one expected move; every control is a secondary `.btn`. Each
editor opens in place inside this slot, and its fold opener, heading and submit button read the same words.

Below the controls, when a proposal is open, one line with no control:
`Methods and Results change when an experiment or reflection submits them and its review accepts. 1 change is waiting
on the review of Sweep weight decay 0.1–3.0.` — the names are links. A link that only navigates carries no verb.

There is **no Submit** on this page. `paper.propose` and `paper.accept` are not tools.

### Content (`content`, titled **Document**)

The outline and the reading column: the four documents in order, each with its sections, inline citation markers,
figure blocks, the `REFERENCES` ledger at the end of Literature, and any proposed edit rendered as §2.5.

### History (`history`)

One time-ordered list across all four documents — the app's list anatomy, newest first:

- line 1: `Results · revision 4` (the document name, the revision number as a plain fact, not an identifier);
- line 2: `Published from Baseline p=97 reproduction · accepted by Maya Osei's review · 6d ago`, or, for a
  `paper.patch` revision, `Edited by Ada Whitfield · 2d ago`, or, for a legacy row with `updateId` and no proposal,
  the existing honest sentence `From the earlier writing workflow`.
- Revisions beyond the current and published ones are read lazily: the list renders from the workspace until opened,
  then `paper.read { kind, history: true }` fills each document's line set.

### Related (`related`)

Three labelled groups, each a plain list, each entry a name and a link, each unnameable entry omitted:

- **Proposed this paper** — the experiments and reflections behind `proposals[].source`, with their standing.
- **Accepted it** — the reviews behind `publication.reviewId` / `acceptance.reviewId`, with the verdict word.
- **Evidence retained with it** — the union of `publication.evidence[]`, opened in place through `Evidence`.

### Details (`details`)

Last, small, and the only place machine text appears: a `KV` of `Sections 11 · Citations 7 · Characters 9,430 of
160,000`, the four documents' current and published revision numbers, and the proposal's change-artifact hash as mono
text for the one person who needs to check it.

---

## 4. What to remove from today's page

`packages/ui/web/views/paper.tsx` is 572 lines. The following goes.

1. **The four-document collection.** `splitRoutes(DocumentList, DocumentDetail)`, `ListPage`, `useListFilter`, the
   `standing()` row helper and the empty state "No living paper yet". A paper is one record; four rows reading
   `revision 3 · 4 sections` are not a collection, and the filter chips (`published` / `unpublished`) filter a list of
   four.
2. **Raw JSON as the proposal.** `<pre className="prose">{JSON.stringify(d.edit.changes, null, 2)}</pre>` — the
   patch payload shown to a scientist. Replaced by §2.5.
3. **The identifier in prose.** `` `Accepted by review ${proposal.acceptance.reviewId}` `` — a direct breach of the
   2026-09-17 no-identifiers ruling. Replaced by the review's name and verdict.
4. **The invented status.** `<StatusPill value={publication.reviewId ? 'approved' : 'published'} />` — a state word the
   browser computes. The publication's own facts (source, review, date) are the statement.
5. **`Edit {item.title}` per citation** in the act row, and `Edit {section.title}` for the _published_ view's sections
   (today's act edits `shown.sections`, which is the published copy while the toggle is on — editing a section list the
   reader is not looking at).
6. **`Revision {shown.revision}`** as a bare faint line under the heading. A revision number alone answers nothing;
   it belongs in the standing line and in History with its date and author.
7. **`item.identifier` as the ledger's third line**, `item.refs.length` as a count with no way to open anything, and
   `Sections: a, b, c` as a joined string. Replaced by §2.3.
8. **`<details><summary>Proposed and reviewed updates</summary>`** as a fold at the top of the document. A proposed
   change belongs against the text it changes, not in a drawer above it.
9. **The `hidden` four-panel trick** (`KINDS.map(... <div hidden={kind !== value}>`), which exists only to keep four
   drafts alive across a tab switch. With one page and one editor open at a time it has nothing to preserve.
10. **`.claims-form` on the paper's forms** — a form named after another view. It becomes the shared form class the
    editors already need.
11. **`.record` as a wrapper around each section** (`<article className="record stack">`) — padding that survives from
    the card era. Sections sit on the ground, divided by their headings.
12. **`ResearchCommand`**, exported from `paper.tsx` and used by `research.tsx`. Not deleted — _moved_ to
    `components.tsx`, where a shared control belongs. (−48 lines here.)

Kept, deliberately: the optimistic-receipt discipline in `useCommand` (`validate`, `retry`, "Retry same request"), the
character and section budgets checked before submit, and the "Editing revision N" note — reworded to the server's own
conflict sentence.

---

## 5. Build plan — one wave

**Wave: the paper as one document.** One view file, one stylesheet block, no server change, no schema change.

| #   | Step                                                                                                                                                                             | Files                                                     | Δ LOC      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------- |
| 1   | Move `ResearchCommand` to `components.tsx`; fix the import in `research.tsx`.                                                                                                    | `components.tsx`, `views/research.tsx`, `views/paper.tsx` | +46 / −48  |
| 2   | Rewrite `views/paper.tsx` as one `RecordPage`: outline + reading column + act + history + related + details. Drop `splitRoutes`/`ListPage`.                                      | `views/paper.tsx`                                         | ~340 total |
| 3   | `paragraphs(content)` (split on blank lines) and `numbering` (derived `n` / `n.m`) — two small pure helpers.                                                                     | `views/paper.tsx`                                         | +18        |
| 4   | `wordDiff(before, after)` — LCS over whitespace-split tokens, returning `{ same \| add \| del }` runs.                                                                           | `views/paper.tsx`                                         | +34        |
| 5   | Citation markers, the hover card, and the ledger as `<details>` rows using the shared `Evidence`.                                                                                | `views/paper.tsx`                                         | +52        |
| 6   | Figure blocks from `publication.evidence` and `citation.refs`, via `useArtifacts` + `Evidence`.                                                                                  | `views/paper.tsx`                                         | +24        |
| 7   | Name the sources: `experiment.list`, `reflection.list`, `review.list`, actor names — all existing reads; unnameable entries omitted.                                             | `views/paper.tsx`                                         | +28        |
| 8   | Stylesheet: one `Paper` block (~110 lines) — measure, leading, outline, numbers, markers, hover card, diff marks, dark overrides. Delete the paper's share of `.record` padding. | `styles.css`                                              | +110 / −20 |
| 9   | _Optional, separable:_ CSV/TSV files render through `Table` inside `ArtifactBody`.                                                                                               | `views/artifacts.tsx`                                     | +26        |

**Net:** `views/paper.tsx` 572 → ~500; `components.tsx` +46; `styles.css` +90. Whole-repo net ≈ **+60 lines** before
step 9, against a page that today has no diff, no citation display, no outline and no history. The LOC rule
(`memory/loc-reduction-target.md`) is not met by this page alone: say so in the merge, and pay it with the removals
that the same cleanup wave makes elsewhere (the Cycles and Knowledge rows the founder has already ruled out are worth
367 lines between them).

**Verification**, per `docs/UI_DESIGN.md` phases: `npm run typecheck:ui`, `npm run test:ui`,
`node --import tsx --test tests/ui-navigation.test.ts`, `npm run build:ui`, `npm run format:check`, and report the net
line count of `packages/ui/web`. Visual check with `dev_docs/cordis_seed_more.mjs` + `dev_docs/cordis_shot.mjs` at
1440 and at 900, light and dark.

### Risks

| Risk                                                                                                                                               | Mitigation                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Four extra list reads** (`experiment.list`, `reflection.list`, `review.list`, `artifact.list`) to name sources and files.                        | All four are already polled by other views and cached by `useTool`; they are needed only for the Related block and the attribution lines, and **every one of them may fail without breaking the reading column** — an unnameable source is omitted, per the no-identifiers ruling. |
| **A long paper is a long scroll** — 100 sections and 160,000 characters are allowed.                                                               | The sticky outline is the answer; documents past the first render their sections lazily below the fold. No pagination, no folds over content.                                                                                                                                      |
| **Word diff on a 100,000-character section.**                                                                                                      | Diff only sections a proposal actually changes (`edit.changes[].id`), cap at 20,000 tokens and fall back to "the whole section is replaced" above it.                                                                                                                              |
| **Two proposals touching the same section** (possible: proposals are retained until accepted, and `paper_revision_conflict` only fires on accept). | Show each proposal's diff against _its own_ pinned `before`, one under the other, each with its source line. Never merge two proposals into one rendering.                                                                                                                         |
| **The published revision is behind the current one** for Problem/Literature, which `paper.patch` moves without review.                             | The standing line says `current revision 7 · published revision 4`; the toggle reads the published text. Never imply a `paper.patch` edit was reviewed.                                                                                                                            |
| **Someone asks for an accept button** on a pending proposal.                                                                                       | Refuse in the review: `paper.accept` is not a registered tool, and a sixteenth verb is a different system (`docs/UI_TRANSLATION_2026-09-16.md` on the primitive set).                                                                                                              |
| **The map and the palette** reference paper sections as record nodes (`map.tsx`), and `⌘K` does not search documents.                              | Out of scope for this wave; the route shape `/paper/:kind#<section>` is unchanged, so the map's links keep working. Palette search over sections is a separate, small follow-up.                                                                                                   |

---

## 6. The sketch

`Paper.dc.html` beside this file: a static, self-contained page at 1440 wide in the contract's visual language — rail,
title line, act, outline, reading column, four Problem & scope sections, a Literature section with inline markers and
the `REFERENCES` ledger, a Methods section, a Results section carrying a pending proposed edit as the quiet diff, then
History, Related and Details. Light and dark both render from the same tokens (the page follows
`prefers-color-scheme`).

Its content is the seeded grokking project from `dev_docs/cordis_seed_more.mjs` — the p=97 modular-addition question,
the four Problem sections verbatim, the baseline run's step 1,640 / step 9,810 numbers, the sweep's two-of-four runs
with one censored — and three real papers in the ledger. **No metric that the seed does not contain appears anywhere.**

Rendered beside it: `sketch.png` (1440, light), `sketch-dark.png` (1440, dark),
`sketch-900-top.png` (900, the responsive fallback where the outline becomes one row and the pane divider goes,
because with one pane a left rule would be exactly the edge the founder banned). One citation card is drawn open
so a still frame shows the hover mechanic; nothing is open by default in the real page.

Two things the sketch deliberately does **not** show, because the plugin cannot produce them: an image figure
(Merv artifacts are UTF-8 text or "Binary file" — `ArtifactBody` has no image path), and an accept or reject control
on the pending change.
