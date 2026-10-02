# UI inspiration board (2026-10-01)

The same board as a page, with screenshots of the current UI: https://claude.ai/artifact/GAFfwCwU9oKPJ566VjQ6hK (private to its owner until shared).

Every page of the TypeScript UI, grouped into eleven categories by the job each serves, with where each falls short. For each category there are four or five products that do that job better: what they do, what Merv could borrow inside its own design language, and what to leave behind.

Walked on 1 October 2026: the live app (experiments.rapidreview.io, four projects) and a seeded local demo, about 45 screens across both themes and phone width. Each reference case was checked against a page fetched on the same day; anything that could not be checked is marked unverified. This is inspiration, not a plan: `docs/UI_DESIGN.md` remains the contract, and nothing here overrides a ruling in it.

## Categories, most in need first

| Category                        | Need   | The lead problem                                                                     | Look at                                                                                    |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| B. Orientation and attention    | High   | Home counts things; it never says what was learned or what changed.                  | Google Drive · Linear · Sentry · Devin · GitHub                                            |
| D. Results, evidence and files  | High   | An experiment page shows no result: no number, table or chart.                       | Weights & Biases · Hugging Face Hub · Sanity Media Library · Zotero 7                      |
| F. Synthesis and writing        | High   | The reflection page shows the process and none of what was learned.                  | Sentry Seer · Eppo · Quarto Manuscripts · Google NotebookLM · GitBook                      |
| G. Agent chat                   | High   | The product's main control surface speaks in tool names and raw JSON.                | Shopify Sidekick · Atlassian Rovo Chat · GitHub Copilot on github.com · MCP Apps in Claude |
| H. Live operations              | High   | Three pages answer one question, and none says what an agent is actually doing.      | Warp · Google Antigravity · Buildkite · Vercel                                             |
| K. Reading and detail grammar   | High   | Every record is a label or a wall of text, and detail opens four different ways.     | Sentry · Semantic Reader · GitHub · GOV.UK Design System · Jira                            |
| A. Access and project switching | Medium | 46 projects behind an alphabetical wall of buttons, and a switcher nobody can see.   | Vercel · Slack · Google Docs · OpenAI Codex cloud                                          |
| C. Work tracking                | Medium | Five rows of filters before the first item, and records that bury their outcome.     | Linear · GitLab · Basecamp · Discourse · Jira                                              |
| E. Review and verdicts          | Medium | The verdict is at the bottom, and a failed review leads nowhere.                     | Relativity aiR for Review · SafetyCulture · F1000Research · eLife                          |
| I. Code                         | Medium | A drawing that has to be taught, with no way to be taught it.                        | GitHub · Sapling · Trunk Merge Queue                                                       |
| J. Settings and administration  | Low    | Account, project and system settings share one list; the budget hides under Session. | Linear · Stripe · Vercel · Devin · Claude                                                  |

## A. Access and project switching

**Covers:** Sign in · Choose a project · project switcher · account menu · a new project's first minutes

**Job:** Get in, find the right project among many, move between projects, start a new one.

### Where it falls short

1. The switch control has no signifier. It is invisible until the pointer is over it.
2. Switching leaves the app for a full-page chooser and always lands on Home, so your place is lost.
3. 46 identical buttons in alphabetical order: no recency, pinning, state or last activity. Two projects with the same name cannot be told apart.
4. No view across projects. Which project is running, stuck or needs you is unknowable without opening each.
5. A new project is a name, then a Home of zeros. There is no first-run path.
6. Joining a project means finding your account ID in a fold on the chooser and sending it to someone.
7. Account-level things (keys, provider tokens, theme) are split between the chooser, the account menu and project Settings.

### Who does this better

**Vercel — the scope switcher, and projects as filters** (answers 1, 2, 3, 4, 7)

The scope's name carries an up/down chevron and opens a popover anchored to the name, not a new page: teams on the left with a check on the current one; on the right a find field, Favorites above Projects, and a star on the row under the pointer. Picking a project keeps the view you were on. In the 2026 navigation the sidebar is the same at team and project level, so every page also exists across all projects and the project is a filter on it. Supabase's project dropdown does the same route-preserving switch and marks an inactive project with a Paused badge.

- Borrow: A chevron glyph on the rail's project name opens an anchored popover: a search field, pinned projects, then the rest by last activity, each row a name, a state pill and a quiet owner and time line, with New project at the foot. Switching keeps the page (Work stays Work). Now with no project chosen becomes the view across projects.
- Leave: The sidebar's universal Find over teams, projects, pages and settings. It is a command palette under another name.
- Sources: [Switcher changelog, 2023](https://vercel.com/changelog/improved-experience-for-moving-between-your-teams-and-projects), [New dashboard navigation, January 2026](https://vercel.com/changelog/new-dashboard-navigation-available), [Screenshot of the switcher](https://assets.vercel.com/image/upload/contentful/image/e5382hct74si/3ES60Rt245tB0uSflVNgwY/87cbe5fd26f9b89c23f63067fe84a37b/Frame_4.png)

**Slack — the workspace switcher that carries other workspaces' badges** (answers 1, 3, 4)

Clicking the workspace icon lists every workspace you are signed in to, with a row to add one; the list can be pinned as a column and reordered by dragging. A numbered badge appears on the workspace icon when there is unread activity in your other workspaces, so the switch control itself says that somewhere else wants you. A dot means activity; a number means you were addressed.

- Borrow: When another project holds needs-you items, the rail's project name shows that count beside the chevron and each popover row shows its own. A plain dot means agents are working; a number appears only for needs-you. The one pulse goes on a count that just arrived.
- Leave: A coloured avatar per workspace and read/unread semantics. Colour belongs to record kinds, and mark-read is an inbox verb on the never list.
- Sources: [Switch between workspaces](https://slack.com/help/articles/1500002200741), [Guide to Slack notifications](https://slack.com/help/articles/360025446073) (Whether each pinned icon carries its own badge is unverified.)

**Google Docs — You need access → Request access** (answers 6)

Opening a link you cannot use shows You need access with Request access, an optional reason and Send request. The owner receives your name, the file and your message, and chooses a role in the same step; since late 2024 they can decide inside Chat. Linear adds the switcher side: a number beside Create or join a workspace means an invitation is waiting.

- Borrow: The project's address is the invitation. A non-member who opens it sees the project's name and one control, Ask to join. The owner gets a Now row with a role select and Add. The requester's project list shows the project with a Pending pill until someone decides.
- Leave: An outcome the requester cannot see. Google admits a request can be decided silently; in Merv the state is always a pill.
- Sources: [Access to Google files](https://support.google.com/docs/answer/16722399), [Access requests in Chat, November 2024](https://workspaceupdates.googleblog.com/2024/11/auto-installed-google-drive-chat-app.html)

**OpenAI Codex cloud — setting up the first environment** (answers 5)

Create environment, choose repositories (connecting GitHub if asked), then Get started. From there the agent does the setup: it inspects the repositories, installs dependencies and tests the workflow, and the person only supplies missing access or information when asked. They read the setup report and start the first task.

- Borrow: New project asks for one sentence (the problem) and a repository, then starts the agent. Instead of a Home of zeros the project shows its first run as a small state diagram (Problem, Repository, Agent, First work) with the position marked, and anything the agent needs arrives as a needs-you row.
- Leave: The Publish gate after reviewing the setup report. Sign-off framing is ruled out.
- Sources: [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments), [Codex cloud](https://learn.chatgpt.com/docs/cloud)

**Top pick.** Vercel. One anchored control answers four findings at once: the missing signifier, losing your place, the alphabetical list and the missing view across projects. Its idea of the project as a filter on the same page gives Merv a cross-project Now without a new kind of page.

**What they share.** The best products never send you to a separate page to change context. The scope's name is the control, marked by a chevron, and it opens where it stands. The list is ordered the way the person uses it (pinned, recent), the page you were on survives the switch, and a count on the switcher says another scope needs you. Access is requested from the link you were sent and decided in the app with a role attached. First run is the system doing the setup and asking only for what it lacks.

## B. Orientation and attention

**Covers:** Home · Now · the rail's needs-you count

**Job:** On opening a project, know in seconds what needs me, what is moving, and what changed.

### Where it falls short

1. Home is an inventory of counts. A finished project reads as a page of zeros, with the outcome nowhere on it.
2. No time dimension: nothing separates what is new since yesterday from what has sat for a week.
3. The records drawing shows 4 of 21 items, leaves a wide empty column at 1440px, and the selected card's detail opens far from the card.
4. Now is the page that matters but is the second row; Home repeats it as three numbers.
5. On Now the control is 1,000px from the row's name, every row repeats a fold, nothing orders rows by age, and there is no way to peek at a record without leaving.
6. The same item is classified differently on two pages: a pull request waiting for a person is Waiting on Now and red on Running.
7. Gate sentences leak machine language ("A worker session holds this revision; the operator who offered it can halt it").
8. Nothing reaches the person outside the app when something needs them.

### Who does this better

**Google Drive — Catch me up, and the changed-since-you-last-viewed marks** (answers 1, 2)

Change is measured from the viewer's own last view. Drive Home carries one Catch me up prompt that opens a side panel summarising edits and comments on files changed since you last viewed them. In any file list those files carry an activity indicator, and clicking it shows that one file's changes. Inside a document a dot on the last-edit icon means someone edited it since you looked.

- Borrow: Keep each person's last visit per project. Home opens with what changed since then: a hairline list under that date, one row per record that moved (kind label, name, old pill to new pill), plus what the agents concluded since. Rows on Now and Work that changed since your visit carry one small dot.
- Leave: The AI prose summary, which Google says is not comprehensive. Merv can compute the changes exactly from workflow transitions.
- Sources: [Catch me up in Drive, June 2025](https://workspaceupdates.googleblog.com/2025/06/catch-me-up-in-google-drive.html), [See what changed in a file](https://support.google.com/docs/answer/190843)

**Linear — the project health pill and Pulse (not the Inbox)** (answers 1, 2, 5, 8)

Each project carries a health pill (On track, At risk, Off track) from its latest update, and clicking it in a list shows the recent updates in place. The pill ages: a dashed outline when an update is overdue, then grey, then Update missing. Pulse gathers updates into one feed and delivers a daily or weekly summary at about six in the morning; updates can also post to Slack.

- Borrow: Give the current cycle one health pill, set by the latest reflection or finding. When nothing arrives on schedule its outline goes dashed, then grey, so staleness is drawn rather than written. Clicking it shows the latest synthesis. A morning digest by email or Slack carries the needs-you items and the findings since the last one.
- Leave: Reminders asking people to write updates, ranking by reactions, custom feeds (saved views) and audio.
- Sources: [Initiative and project updates](https://linear.app/docs/initiative-and-project-updates), [Pulse changelog, April 2025](https://linear.app/changelog/2025-04-16-pulse), [Screenshot](https://webassets.linear.app/images/ornj730p/production/876a872f81a5d77f2959e3d723738ba289cf6f55-3600x1800.png)

**Sentry — issue states that age by themselves, and For Review** (answers 2, 5, 6, 7)

An issue has exactly one status at a time. New means created in the last seven days and becomes Ongoing by itself; a fixed issue that recurs becomes Regressed; an archived one whose volume beats the forecast returns as Escalating. For Review holds the new or regressed issues nobody has looked at. Priority is set and raised automatically, but a priority a person changed is never overwritten.

- Borrow: Compute each item's attention state in one place and show it the same way on every page, and let time change it. A new mark drops away by itself. Work a review sent back gets a returned state that sorts first. Within a group, rows sort by age. A person's override sticks.
- Leave: Mark reviewed, archive and priority menus. Inbox verbs are ruled out, so the ageing has to do that work.
- Sources: [Issue states and triage](https://docs.sentry.io/product/issues/states-triage/), [Escalating issues, 2023](https://sentry.io/changelog/2023-9-21-find-trending-problems-faster-with-escalating-issues)

**Devin — sessions grouped by status, with status pushed outside the app** (answers 4, 6, 7, 8)

The session list is the persistent sidebar. Group by status uses Working, Ready, Blocked and Inactive, so a pull request awaiting your review and a session that cannot continue without you are listed apart. The desktop app sends a native notification when any session finishes or needs input, and a Slack message carries a working, blocked or done chip that links back. Sessions quiet for thirty days leave the default list.

- Borrow: Split Needs you by what the person must do: Ready is a delivery or pull request waiting for your judgement or merge; Blocked is an agent that cannot continue without you. That settles where the unmerged pull request belongs on every page. Plain state words replace the gate sentences, and a notification fires only when an item enters Ready or Blocked.
- Leave: Folders, tags, multi-select filters, pin and archive.
- Sources: [Release notes, 2026](https://docs.devin.ai/release-notes/2026), [Slack integration](https://docs.devin.ai/integrations/slack)

**GitHub — the agents panel and the session side panel** (answers 3, 4, 5, 8)

An Agents button in the global header opens a light overlay on any page listing delegated tasks with a status; a task opens its pull request, and View all opens the full page. When Copilot finishes it tags you for review, so the ordinary notification reaches you. Since April 2026 an issue's header pill lists its sessions, and clicking one opens a sidebar with progress and logs without leaving the page.

- Borrow: The Now count in the rail opens the Now list over the page you are on. Any Now or Home row opens its record in a panel beside the list: the workflow diagram with its position, the state sentence, the one control.
- Leave: The overlay's box for creating tasks. Creation belongs in the Agent chat.
- Sources: [Agents panel, August 2025](https://github.blog/changelog/2025-08-19-agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github-com/), [Sessions from issues and projects, April 2026](https://github.blog/changelog/2026-04-23-view-and-manage-agent-sessions-from-issues-and-projects/), [Screenshot](https://github.blog/wp-content/uploads/2025/08/Agents-panel-with-callout-2.png) (The panel's status words are not documented.)

**Top pick.** Google Drive's changed-since-you-last-viewed marks. It is the only case that measures change from the viewer's own last visit, which is exactly what Home lacks. It needs one stored time per person, a dot and a short list, and Merv can show exact old-to-new state changes where Google needs an AI summary.

**What they share.** Each item has one status from a small, plain vocabulary, computed once and shown the same everywhere. Time acts on that status without anyone pressing a button: new becomes ongoing, a health pill goes dashed then grey, quiet items drop off, and a per-person mark shows what changed since you looked. So the attention list orders and empties itself. The list is one step from any page and opens detail beside itself, and the same status leaves the app as a notification or a morning digest.

## C. Work tracking

**Covers:** Work · task, experiment and cycle records · New cycle · Previous research

**Job:** See the current wave of work, find one item, read its state and history, start more.

### Where it falls short

1. Five stacked rows of controls precede the first list row, and the chips overlap in meaning (open against in progress, in review, planned, running; complete against done).
2. The one primary button creates a cycle, which the list does not show. Tasks and experiments cannot be made here and nothing says who makes them.
3. The creation form opens inside the list pane; its checkbox floats centred above its own label.
4. One flat list: no grouping, ordering or density control. Dependencies show only as an indent.
5. The record buries the outcome. An experiment's conclusion sits under History at the bottom while the top shows it cut with an ellipsis.
6. Descriptions are raw agent text, and maths with underscores is mangled into italics.
7. Empty rows are drawn (Owner with no value) and internals leak ("succeeded without code, so a later base looks past it").
8. The workflow diagram is not interactive: a state does not open the review that happened there, and carries no time.
9. A count beside a title means open, so Reflections 0 stands over a list holding one reflection.

### Who does this better

**Linear — the list's Display control, and Time in status** (answers 1, 4, 8, 9)

A single Display control above the list holds the layout, grouping, order and which properties rows show. Grouped by status, each group header carries its own count, and the groups follow the workflow's order because every status belongs to one of five fixed categories. Completed items can be limited to a recent window. Since January 2026 a row can show how long the item has been in its current status, and hovering the status lists the time spent in each.

- Borrow: Fold the tabs, the Mine and Everyone switch and the chip rows into one glyph control. Group the list by workflow state in the diagram's order, give each hairline group header its real count, and limit finished groups to a recent window. Put the time in state beside each row's pill; hovering the pill lists the time spent in each state.
- Leave: Custom views and Set as default (saved views are ruled out), and the long menu of properties.
- Sources: [Display options](https://linear.app/docs/display-options), [Time in status, January 2026](https://linear.app/changelog/2026-01-29-time-in-status), [Screenshot](https://webassets.linear.app/images/ornj730p/production/e3d311d10fbbce382a9142fd6dab1a25198b3023-3600x2080.png) (Height, a seed, shut down in September 2025 and was dropped.)

**GitLab — the pipeline mini graph** (answers 8)

Wherever GitLab shows a pipeline or a commit, a row of status icons, one per stage, summarises it. Hovering a stage shows its name and status. Selecting it opens that stage's jobs in place, failed ones first. The small marker opens onto what happened at each stage without leaving the list.

- Borrow: Make the workflow dots on each row, and the diagram on the record, selectable. Hovering a state shows its name and the time spent there. Selecting a review state opens a short hairline list of the rounds held there (verdict pill, reviewer, when), needs-changes first, and each round opens its verdict.
- Leave: Retry and cancel controls, and status icons in place of Merv's state words.
- Sources: [Pipelines](https://docs.gitlab.com/ci/pipelines/), [Screenshot](https://docs.gitlab.com/ci/pipelines/img/pipeline_mini_graph_v16_11.png) (Whether durations appear in the dropdown is unverified.)

**Basecamp — Hill Charts and the Hilltop view** (answers 2, 4, 8)

Each tracked list is a dot on one shared curve, so a whole body of work reads as positions on one path. Every update is saved, and the history steps back through earlier positions. The point, in Shape Up's words, is that a dot that does not move is effectively a raised hand. Hilltop shows every chart on one screen, freshest first, and drops charts idle for three months.

- Borrow: Draw a wave as its two workflows, experiments and tasks, with each item a dot at its current state, named on hover. The cycle becomes a visible object on Work, stepping back replays the drawing at earlier state changes, and an item that has not moved shows its age.
- Leave: Positions dragged by hand, and the hill metaphor. Merv's positions come from the gates.
- Sources: [Hill Charts](https://5.basecamp-help.com/article/1078-hill-charts), [Shape Up, chapter 13](https://basecamp.com/shapeup/3.4-chapter-13), [Screenshot](https://basecamp.com/assets/images/books/shapeup/3.4/snapshots.png)

**Discourse — Solved: the accepted answer under the question** (answers 5)

When a reply is marked as the solution, it is shown directly beneath the topic's opening post, under the question it answers. Topic lists mark solved topics. The thread stays below as the process.

- Borrow: An experiment already is a question. Put its conclusion directly under it, in full, with the verdict pill that accepted it linking into that review. Evidence and History follow as the process.
- Leave: The length-capped excerpt. That is the truncation this page already suffers from.
- Sources: [Discourse Solved](https://meta.discourse.org/t/discourse-solved/30155)

**Jira — suggested child work items** (answers 2, 3)

While adding a child to a parent work item, Suggest work items drafts proposed children from the parent's details. Each suggestion can be accepted, edited or declined, and accepting creates the child already linked to its parent, so the proposal appears where the work will live.

- Borrow: Tasks and experiments an agent drafts appear as amber proposal rows inside their wave. The page's primary control asks the agent for the next work instead of opening a cycle form inside the list pane.
- Leave: A one-shot AI button that goes around the chat agent, which stays the control surface.
- Sources: [Create a work item and a subtask](https://support.atlassian.com/jira-software-cloud/docs/create-a-work-item-and-a-subtask/) (GitHub's issue dependencies add one detail: a Blocked marker on the row and the relation in the record, never an indent.)

**Top pick.** Linear's Display control with Time in status. One control and a grouped list answer four findings, and it fits Merv's grammar directly: hairline group headers in workflow order, the count with its group, a duration beside the pill.

**What they share.** The best products show state through structure rather than filters: work is grouped or placed along its own workflow and each count sits with its group. They attach time to state, so stalled work is visible without words. The small state marker opens onto what happened at that state. The answer sits above the process, and new work appears where it will live, with who drafted it visible.

## D. Results, evidence and files

**Covers:** An experiment's result and evidence · Files · the Markdown and JSON viewers · Upload file

**Job:** See what an experiment found, compare it with others, and reach the evidence behind it.

### Where it falls short

1. The experiment page shows no result. Metrics live in JSON behind folds; a running experiment shows a raw JSON exhibit and no live metric, log, machine or time left.
2. Experiments cannot be compared: no table of experiments by metric, no difference from a baseline, though sweeps are the normal case.
3. Evidence is named by file path and opened one file at a time. An exhibit is never drawn as a figure or table.
4. Files is one flat list (168 in a real project): no grouping by the record that produced a file, no type filter, no version stacking, fifteen rows for one fifteen-part bundle.
5. A file does not say where it is used.
6. Upload is a native file input with a limitation sentence. No drag and drop.
7. Images and plots produced by experiments are never shown inline.

### Who does this better

**Weights & Biases — a baseline run in the runs table, and the Run Comparer** (answers 2, 3, 7)

Set as baseline moves a run to the top of the list with a bookmark mark, and every other run's metric cell then shows its difference to the right of its value. Marking a column as higher-is-better or lower-is-better decides which differences read as better. Overlaid line plots draw the baseline heavier. The Run Comparer is a table with one column per run and rows of settings and metrics; Diff only hides the rows that are identical. ClearML's comparison does the same and sets each run's images side by side.

- Borrow: A comparison is one hairline table: experiments are columns, the reference first under a word pill, identical setting rows folded by default, and each metric cell a value with a muted signed difference. The plan already says which direction is better, so the better value is set in heavier type with no colour to explain. Overlaid curves draw the reference heavier.
- Leave: The workspace of metric panels, which is the dashboard already ruled out, and difference chips rounded so far that a small change prints as 0.
- Sources: [Compare runs](https://docs.coreweave.com/models/runs/compare-runs), [Run Comparer panel](https://docs.coreweave.com/models/app/features/panels/run-comparer), [Screenshot](https://mintcdn.com/coreweave-dbfa0e8d/3Dv_sw2eg8feUJlx/products/wandb/_media/compare_metric_deltas.png), [ClearML: comparing tasks](https://clear.ml/docs/latest/docs/webapp/webapp_exp_comparing/) (MLflow's comparison was dropped: it duplicates this and makes the person pick axes.)

**Hugging Face Hub — Evaluation results on the model page, gathered on the benchmark's page** (answers 1, 2, 3, 5)

A result is a small structured record stored with the model: benchmark, task and value, with an optional date, notes and source. The model page shows an Evaluation results section with one row per benchmark and task, its score, and a badge saying where the score came from (verified, community, or a link to the logs). The benchmark's own page gathers every reported score into a ranked list that links back to each model. The model page also lists where the model is used.

- Borrow: The exhibit's metrics become a Result block at the top of the experiment: measure, value, difference to the reference. Each value carries a pill for how far it has been checked (results review passed, in review, returned) and links to its evidence instead of hiding in a fold. The same values are gathered on the record they answer, the cycle or a shared measure, as a ranked hairline list that links back, so comparison belongs to a question rather than a dashboard.
- Leave: The public-leaderboard extras: size filters, unexplained asterisks, scores submitted by anyone. A Merv result has one producer and one review gate.
- Sources: [Evaluation results](https://huggingface.co/docs/hub/main/en/eval-results), [Community evals, February 2026](https://huggingface.co/blog/community-evals), [Screenshot](https://huggingface.co/huggingface/documentation-images/resolve/main/evaluation-results/eval-results-previw.png) (The Hub's file browser was dropped: a path tree makes the path the identity.)

**Sanity Media Library — asset versions that say where each is used** (answers 4, 5, 6)

The grid shows one tile per asset. Its versions sit in a side panel, one row each (thumbnail, name, date, how many places use it), with the live one marked Current. A dot beside a version expands the list of where it is used, and outdated versions still in use are marked. Files dragged from the desktop onto the window start uploading at once, with progress shown on each.

- Borrow: The four near-identical lens reports become one row with a version count. The file's page lists versions newest first, each with where it is used (delivered by, cited by the results review). When a verdict still cites a superseded version, that citation carries a superseded pill. Upload is a drop onto the list or onto a record's Evidence, with progress as the row's state.
- Leave: Set as current and sync all usage. Rewriting citations would change the evidence behind a settled verdict.
- Sources: [Asset versions](https://www.sanity.io/docs/media-library/asset-versions), [Media Library interface](https://www.sanity.io/docs/media-library/interface), [Screenshot](https://cdn.sanity.io/images/3do82whm/next/993d7d54a3ed502fa0ddf887c5b4a71f4cbce620-1443x974.png)

**Zotero 7 — attachments nested under their item, and the item pane** (answers 3, 4, 5, 6, 7)

A file is either standalone or a child of a bibliographic record. A parent row opens to show its PDF and notes as indented rows beneath it, and dropping a file on an item attaches it there. The item pane is a set of collapsible sections: Attachments shows a count and a first-page preview, and another section lists every collection that holds the item.

- Borrow: Group Files by the record that produced them: the record's kind label and name form the parent row, and its files sit beneath it labelled by role (plan, result, report, exhibit, figure). A fifteen-part bundle is one row with its count. Selecting a file previews it in place: a first page, a figure, or an exhibit drawn as a table.
- Leave: The hand-built collection tree and the tag cloud. Merv already knows where each file came from.
- Sources: [Zotero 7, August 2024](https://www.zotero.org/blog/zotero-7/), [Attaching files](https://www.zotero.org/support/attaching_files), [Screenshot](https://www.zotero.org/static/images/blog/7.0/library.png) (None of the four covers a running experiment's live view (metric, log, machine, time left); Live operations comes closest.)

**Top pick.** Hugging Face's evaluation results. It is the only case that turns a result from a file into a typed fact on the record that produced it, says how far each number can be trusted, and puts comparison on the question rather than on a dashboard. Weights & Biases supplies the mechanics of the comparison table.

**What they share.** The best products treat outputs as parts of a record, not entries in a library. A number appears where it was produced, says how far it has been checked, and is gathered on the question it answers. A file sits under the thing that made it; its versions fold into one row that says where each is used, and previews open in place. Every comparison is anchored to one named reference, hides what is equal, and prints the difference beside the value.

## E. Review and verdicts

**Covers:** The verdict page · Checks · Claim review · Submit verdict · Submit delivery · review rounds

**Job:** Judge a delivery against its checks; later, understand why it passed or failed and whether the objections were answered.

### Where it falls short

1. The overall verdict is last. The page opens on check 1 even when checks 3 and 4 failed, with no "2 of 4 not met" and no failed-first order.
2. The criterion's boilerplate text dominates each box; the finding is quieter.
3. A Needs changes verdict leads nowhere: no link to the next round, no view of whether each objection was addressed, no difference between the two submissions.
4. Evidence opens one file at a time under the finding. Claim and evidence are never side by side.
5. Producer and reviewer notes are long agent paragraphs. One check listed 22 cited files, fifteen of them parts of one bundle.
6. Rounds on a record carry no reason; you open each review to learn why it bounced.
7. A person may override an agent's verdict, but the page gives that act no place of its own.

### Who does this better

**Relativity aiR for Review — the analysis pane beside the document** (answers 2, 4, 5, 7)

In legal discovery a model judges documents against written criteria while lawyers supervise. A pane beside the document names which version of the criteria was applied, then for each analysis shows the verdict word, a Rationale, a Considerations paragraph in which the model is asked to argue against itself, and numbered citation cards. Clicking a card scrolls the document to the highlighted passage. Citations are capped and machine-checked: one not found in the text is marked an error. The model never writes the human's coding fields, and a dashboard counts where the two disagree.

- Borrow: Each check row becomes a pill, a one-sentence finding, one line on what would reverse it, then two or three quoted excerpts. Selecting an excerpt opens the file beside the checks, scrolled to those lines. A person's judgement is a second, attributed pill on the same row and never an edit of the agent's; when the two disagree the verdict header shows that as a state.
- Leave: The numeric score and the per-type highlight colours, which need a legend.
- Sources: [aiR for Review results](https://help.relativity.com/RelativityOne/Content/Relativity/aiR_for_Review/aiR_for_Review_results.htm), [The analysis pane in the Viewer](https://help.relativity.com/RelativityOne/Content/Relativity/Viewer/aiR_for_Review_Analysis.htm), [Screenshot](https://help.relativity.com/RelativityOne/Content/Resources/Images/Features/Viewer/DGM_aiR_for_Review_Analysis.png)

**SafetyCulture — the inspection report: counts first, then only the failures** (answers 1, 2, 3)

Page one is the title, the date and inspector, a state word and one strip of three numbers: score, flagged items, actions. Page two collects only the failures: each flagged question under its section, the answer as a red block, the inspector's note, and the follow-up attached beneath. The full checklist follows in its original order.

- Borrow: Under the verdict title, one line of counts (2 of 4 not met). Not-met checks come first, each as a pill, the finding, then what the next round must show; met checks follow at one line each. The criterion's text shrinks to a small line above the finding.
- Leave: The Create action or Skip triage. Merv's workflow carries objections forward, and Skip is an inbox verb.
- Sources: [Report layouts](https://help.mitti.com/003189), [Sample report (PDF)](https://assets.ctfassets.net/ueprkma36dz5/2BXhwxmCbWR1KmzLhoaPZG/897dc9ab333ec8428f5188dd4ba7b1c1/Security-Audit-Checklist-Sample-Report-SafetyCulture.pdf), [Screenshot](https://images.ctfassets.net/wum34wy9buzj/7DykPfTDYjN0O2W9SpNhnE/38f1e88628100559de4834e62605fbb4/review-flagged.png)

**F1000Research — the open peer review status grid** (answers 1, 3, 6)

Under Reviewer Reports sits a grid: columns are the reviewers, rows are the article's versions with dates, newest first. Each cell holds that reviewer's verdict on that version and a link to the report, and each report ends with the authors' dated response. Reviewers re-review a revision specifically to say whether it now earns a better status.

- Borrow: On the record, replace the round lines with a hairline grid: rows are submissions, newest first, columns are the checks, and each cell is a Met or Not met pill that opens that round's finding. Whether an objection was dealt with reads down its column, and each row shows why it bounced without being opened.
- Leave: The status key (a legend) and numbered versions. With one reviewer per round the columns are checks, not people.
- Sources: [An article with two reviewed versions](https://f1000research.com/articles/13-921/v2), [How peer review works at F1000](https://www.f1000.com/resources-for-researchers/how-to-publish-your-research/peer-review/)

**eLife — the eLife Assessment and the version log** (answers 1, 2, 3, 6)

The editors' verdict sits at the top of each article, above the paper and the reviews: a short paragraph built on two fixed, defined scales. Each revision republishes an updated assessment, updated reviews and the authors' response. The version log is a vertical list with the version being read marked, and an older version carries a notice linking to the latest.

- Borrow: The synopsis moves to the top as a pill and one sentence. A superseded verdict shows one line pointing to the newer round. The round list marks the current position, the way the workflow diagrams do.
- Leave: A second scale such as significance. Merv's verdict is per check.
- Sources: [What is a Reviewed Preprint, January 2026](https://elifesciences.org/inside-elife/e793d834/what-is-a-reviewed-preprint), [Comparing assessments across revisions, March 2026](https://elifesciences.org/inside-elife/e9d530fc/the-elife-model-comparing-elife-assessments-across-revisions), [Screenshot of the version log](https://iiif.elifesciences.org/journal-cms/blog-article-preview%2F2025-11%2Fimage-20251111162852-1.png/full/full/0/default.png) (The seeds were dropped: OpenReview's decision is one reply in a stream, Gradescope's rubrics are reusable items, and CodeRabbit adds agent prose rather than reducing it.)

**Top pick.** Relativity aiR. It is the only case where an AI gives the verdict against written criteria while a person supervises. It supplies the whole row: verdict, rationale, the model's case against itself and a few machine-checked excerpts that open beside the claim, and it keeps the human decision structurally separate from the AI's.

**What they share.** The outcome comes first, in a small fixed vocabulary (a strip of counts, an assessment term, a status mark), before any prose. Failures are pulled to the front. Evidence is a short quoted excerpt that opens in place, not a list of files. A re-review is a new row in a record that is only ever added to, and each earlier objection gets its own verdict there, so whether an objection was addressed is read from the structure, not from a conversation.

## F. Synthesis and writing

**Covers:** Reflections · the reflection record · Paper · references

**Job:** Read what a wave of experiments taught us and what changes next; read and maintain the living paper.

### Where it falls short

1. The reflection page shows process, not content. What was learned and what changes next are inside Markdown and JSON files.
2. The change specification, the proposed next tasks and experiments, is a JSON file and is never rendered as the list of work it is.
3. Two words for one thing: lenses in the list, perspectives on the record.
4. The paper is long agent prose with no figures or tables from the experiments, and no path from a sentence to the experiment or review behind it.
5. No history: what changed in the paper after a wave cannot be seen.
6. The paper's state line is cryptic, and an empty paper is a doubled skeleton of headings with no first step.
7. No visible way to take the paper out.

### Who does this better

**Sentry Seer — the issue-fix flow: root cause, then solution, then changes** (answers 1, 2)

The Root Cause card opens with a one-sentence conclusion. Below it the causal chain is a vertical list of collapsed steps; the decisive step is marked and arrives already open, with its explanation, a code excerpt and a file chip, and any key insight expands to the data behind it. A Solution follows as a list of steps the person can remove or add to before anything is built from it.

- Borrow: The reflection reads top to bottom: the synthesis's conclusion sentence; the findings as collapsed hairline rows that open onto the experiments and review findings behind them, the decisive one already open; then the change specification as amber proposal rows (kind, name, dependents indented, the finding that motivated it) which the owner can remove before they become work. Once the work exists the row is the live task or experiment with its state pill. The lenses drop to a fold at the foot.
- Leave: The person's go-button that starts the build, and the streamed thought log. Sign-off framing is ruled out and the stream is noise.
- Sources: [Root cause analysis](https://docs.sentry.io/product/ai-in-sentry/seer/root-cause-analysis/), [Issue fix](https://docs.sentry.io/product/ai-in-sentry/seer/issue-fix), [Screenshot](https://docs.sentry.io/mdx-images/rca-HUPG52GY.png) (How a step is removed on screen is unverified.)

**Eppo — the experiment report's overview and the Knowledge Base** (answers 1, 4, 6, 7)

The header is a Concluded chip, the title and labelled facts: decision, owner, results last updated, all checks passed. A summary card leads with Hypothesis, Key takeaways and Decision; below it the metric tables and charts are live blocks that update with each refresh. The report exports to PDF. The Knowledge Base lists each concluded experiment with its decision, a lift pill for the primary metric and its takeaways, searchable across hypotheses.

- Borrow: A Reflections row says what the wave learned: its name, the headline difference as a pill and the first takeaway, in place of APPROVED · 5 of 5 lenses. The paper's state line becomes labelled facts (last wave, sections reviewed, updated). Results are drawn live from exhibits, never retyped.
- Leave: The boxed card gallery with images and view counts, and the hand-authored block editor. Merv's lists are hairline rows and its reader reads rather than writes.
- Sources: [Experiment reports](https://docs.geteppo.com/experiment-analysis/reporting/experiment-reports), [Knowledge Base](https://docs.geteppo.com/experiment-analysis/reporting/knowledge-base/), [Screenshot](https://docs.geteppo.com/assets/images/top-summary-card-b9c114eb2bab0334bc47f7882c327095.png)

**Quarto Manuscripts — figures embedded from the notebook that made them** (answers 4, 7)

An embed pulls one named figure or table from a notebook into the article, and directly under it sits a small source link. Following it opens the rendered notebook with a way back to the article. The right margin holds the contents, the list of notebooks the article draws on, and the other formats it is offered in (PDF, Word and more).

- Borrow: Results sections embed experiment exhibits as real figures and tables. Under each, one line carries the teal experiment label and the experiment's name and opens that record at its evidence. The sticky contents gains the experiments the paper draws on and the formats it can be taken out in, so export is visible without a toolbar.
- Leave: Link text built from file names. Paths are identifiers; name the record.
- Sources: [Embedding notebook outputs](https://quarto.org/docs/authoring/notebook-embed.html), [Quarto Manuscripts](https://quarto.org/docs/manuscripts/), [Screenshot](https://quarto.org/docs/authoring/images/notebook-links.png)

**Google NotebookLM — inline citations that land on the quoted passage** (answers 4)

Grounded claims carry inline citations. Hovering one shows the full quoted text and selecting it goes directly to the quote in its source. Saving an answer to a note keeps the tables and the clickable citations, so the grounding survives the move. The person chooses which sources may ground an answer.

- Borrow: A paper sentence that rests on Merv evidence ends in a small marker in the evidence's kind colour (teal for an experiment, red for a review), distinct from literature citations. Hover gives a peek with the record's name, verdict pill and the one number; a click opens the record at that exhibit or finding.
- Leave: Numbered markers, since a number is an identifier shown as text, and the chat framing around the answer.
- Sources: [Citations in NotebookLM](https://support.google.com/notebooklm/answer/16179559), [Inline citations announcement, 2024](https://blog.google/innovation-and-ai/products/notebooklm-goes-global-support-for-websites-slides-fact-check/)

**GitBook — the change-request diff view** (answers 5)

Pages that contain changes carry a mark in the table of contents, and Show only changed pages narrows the contents to them. Changed blocks get a coloured gutter bar; edited words show the old word struck and the new one after it. A floating control jumps between changed blocks and on to the next changed page.

- Borrow: The paper gets a since control keyed to waves rather than dates. The sticky contents puts a dot on sections changed since that wave, changed paragraphs get a hairline gutter bar, inserted words a faint tint, and deleted text appears on hover. Each section's 6d ago · never reviewed becomes changed in the last wave, linking to the reflection that caused it.
- Leave: Merge and Request review controls, and the before/after split view that halves the reading column.
- Sources: [Better diff view, October 2024](https://gitbook.com/docs/changelog/2024-product-updates), [Hover-to-reveal deletions (Ink & Switch)](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/04/) (Overleaf's history was tested and dropped as sound but generic.)

**Top pick.** Sentry Seer. Its single column is the page Merv lacks: a conclusion sentence, an evidence chain with the decisive step already open, then proposed steps the person can remove before they become work. It turns the reflection and its change specification into one reading order instead of two files to open.

**What they share.** The best products lead with the conclusion in one sentence and push process (lenses, steps, versions) below it. Every claim is one hop from what produced it: hover to peek, click to land in context. The real output (a number, a table, a figure) is embedded live from the record that produced it instead of paraphrased. Proposed work is rendered as separate objects that become the live records. Change is shown in place, keyed to milestones, not kept on a separate history page.

## G. Agent chat

**Covers:** Agent · conversation switcher · model and machine pickers · Context · proposed actions

**Job:** Ask about the project and tell an agent to act on it, with your own permissions.

### Where it falls short

1. Actions are shown as tool names and raw JSON, and results are echoed as if the person typed them.
2. Answers never render records as objects: no linked task or experiment, no table, chart or file preview.
3. Conversations are reachable only through a dropdown, with poor automatic titles and no search.
4. A new conversation offers nothing to start from.
5. The composer cannot point at a record or a file, and nothing shows what the agent can see.
6. The header carries five controls of equal weight, and Context unfolds the whole system prompt.
7. The agent lives on its own page. You cannot ask about the record you are looking at without leaving it.
8. Approval has one shape for every action, a small button, whatever the consequence.

### Who does this better

**Shopify Sidekick — actions that stage an edit instead of making it** (answers 1, 7, 8)

Sidekick never commits a change itself. An action opens the object's real edit form with the proposal already filled in, either on the app's own page or drawn inline inside Sidekick, and the merchant presses that form's own Save. Questions just get answers. Sidekick opens from any page of the admin.

- Borrow: When the agent proposes creating or changing a record, open that record's own desk beside the transcript, already filled in. The desk's one accent button commits, and a guarded act keeps its guard. The transcript keeps a single line: kind label, name, state pill.
- Leave: The variant that navigates away to another page. The chat is the control surface, so only the inline form fits.
- Sources: [Changelog, June 2026](https://shopify.dev/changelog/sidekick-app-extensions-available-today), [Building app actions](https://shopify.dev/docs/apps/build/sidekick/build-app-actions), [Screenshot](https://shopify.dev/assets/assets/admin/sidekick/email-performance-flow-C00FiYFF.png)

**Atlassian Rovo Chat — confirmation that scales with the consequence** (answers 1, 3, 5, 7, 8)

Skills that write (create, edit, transition, assign) ask the person first. Deleting work items needs a second confirmation, and the agent first shows the list of items to review, with checkboxes. Asked to create several work items, chat lists the candidates; Preview opens them in an editable canvas and one Create all commits. The composer offers "Use what you're viewing as context", files and mentions.

- Borrow: Three tiers set per tool. A read answers silently. A reversible write is one sentence in Merv's words with one button. A costly or irreversible act (halt all leases, revoke a key, publish) lists the affected records as hairline rows with checkboxes above the red-outlined confirm. A wave's worth of new tasks arrives as one editable list ending in a single Create.
- Leave: Slash-command entry points. They are a hidden vocabulary, which is what the ruling against a palette objects to.
- Sources: [Chat actions](https://support.atlassian.com/rovo/docs/chat-actions/), [Create work items with Rovo](https://support.atlassian.com/jira-software-cloud/docs/create-work-items-with-rovo/) (Whether reads skip confirmation, and conversation search, are unverified.)

**GitHub Copilot on github.com — the panel that opens over the page you are on** (answers 1, 4, 5, 7)

The Copilot icon opens a panel over the current page instead of leaving it; an arrow expands it to full-page chat. Opening it on a pull request or an issue attaches that object, objects visited while it stays open keep attaching, and typing @ attaches issues, pull requests, files or repositories. Asked for issues, it drafts them on the repository's own issue form in an editable workbench, and Create or Update commits.

- Borrow: Agent becomes a dock on every page: the rail's Agent row toggles it, and an arrow glyph expands it to the full page. The record on screen enters the composer as a chip (kind colour and name), records visited while the dock is open add chips, each removable, and @ finds records and files by name.
- Leave: Context that accumulates out of sight. In Merv every attached record must be a visible chip.
- Sources: [Changelog, May 2026](https://github.blog/changelog/2026-05-18-ask-questions-in-context-with-copilot-on-web/), [Create or update issues with Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/copilot-for-github-tasks/use-copilot-to-create-or-update-issues), [Screenshot](https://github.blog/wp-content/uploads/2026/05/592530103-73db3755-ad12-49fb-a833-08ed06d6dcd6.jpg)

**MCP Apps in Claude — inline result cards and tool annotations** (answers 1, 2, 8)

A tool names a UI template and the host draws its result as an inline card (fits its content, four or five data points, at most two actions), a carousel of comparable items, or full screen with the composer still present. The card handles direct acts on what it shows; anything that needs language goes back to the composer. Tools declare read-only, destructive and open-world hints, which decide how the host frames and confirms the call.

- Borrow: Merv's chat already calls Merv's own tools. Annotate each tool and let the hint choose the confirmation tier. Give each record kind one card: kind label, name, state pill, the compact workflow diagram, at most four facts and two actions. A tool result is the card of the record it touched, never a You bubble of JSON, and the same card appears when someone drives Merv from Claude or ChatGPT.
- Leave: Image carousels and the host's own typography and accents. Lists of records stay hairline rows in Merv's tokens.
- Sources: [MCP Apps design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines), [MCP Apps announcement, January 2026](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)

**Top pick.** MCP Apps and tool annotations. They fix the raw JSON, the missing record cards and the one-size approval in the tool layer Merv already has: one hint per tool picks the confirmation tier and one card per record kind replaces the JSON. Sidekick and Rovo then supply the shapes for the write tier and the destructive tier.

**What they share.** The assistant sits docked beside the object instead of owning a page, and the object on screen is visible context the person can remove. Proposals arrive as the product's own objects (a filled form, a draft record, the list of records an act will touch) and the person commits with the product's own button, so the agent can never do more than the person could. How often it interrupts depends on the consequence.

## H. Live operations

**Covers:** Running · Sessions · Fleet · dispatch · halting and releasing · budgets

**Job:** See which agents are working on what, on which machines, whether they are healthy, what it costs, and stop or redirect them.

### Where it falls short

1. Three pages answer one question with overlapping parts (dispatch on two, machines in three) and a private vocabulary: runner, lease, session, agent, assignment, dispatch, slot.
2. On the desktop board a session card does not say what it is working on until selected; card text is cut; the line from a session to its work crosses other cards.
3. What an agent is doing is a list of tool names and SUCCEEDED. No content, reasoning, files changed, logs, progress or cost.
4. A red card that needs you offers no action in place. The move is a small link inside a table of facts.
5. Sessions is about 5,000px tall. Released leases and retired agents (354 in a real project, many named by a hostname or a cut id) are listed by default, and choosing an agent jumps the page 3,600px.
6. Idle states look broken: Hardware with a dash over grey placeholder cards; Fleet opens on Nothing open behind a default filter.
7. No history or cost: what ran yesterday, for how long, what it spent, what failed. The daily token budget is a number field in Settings.
8. Stopping things is well guarded, with named consequences. Keep that.

### Who does this better

**Warp — the agent management panel: every run in one list** (answers 1, 2, 5, 7)

Each local conversation or cloud run is one row in a single list: source, status, duration, credits, who started it and when. Status is one of five words (Working, Blocked, Canceled, Failed, Success), and Blocked means waiting on you. Credits fold inference and compute into one number per run. A parent run and each child it spawns are separate rows. Opening a row shows that run's session: the prompt, the plan, commands, logs and output. Notifications for a blocked, finished or failed run open the same session.

- Borrow: Merge Sessions' four tables and Running's session cards into one hairline list of runs, each named by its work. A row gives the role, the state as one of five words in ink (only the one that needs a person is red), the duration and one spend figure, with the machine as a faint suffix. Live runs come first and earlier ones sit under day headings; a retired agent shows only as its finished runs.
- Leave: Emoji status marks and a notification mailbox with mark-as-read.
- Sources: [Managing cloud agents](https://docs.warp.dev/platform/managing-cloud-agents/), [Agent notifications](https://docs.warp.dev/agents/capabilities/agent-notifications/), [Screenshot](https://docs.warp.dev/_astro/management-view-scannable-list.Pmn3h7Ez_1HmQt6.webp) (Cancelling from the list is unverified.)

**Google Antigravity — the Agent Manager and its artifacts** (answers 3, 4)

The Manager is a mission control for agents running in parallel across workspaces. Inside a conversation, raw tool calls are grouped under the task they serve, and the agent reports through artifacts (a task list, an implementation plan, a walkthrough, screenshots), which Google says are easier to check than tool calls. The person comments on an artifact and the agent takes the feedback in without being stopped.

- Borrow: In the session's sidebar, replace Merv calls with the work's checks or plan steps as a ladder (done, doing, not started), built from the agent's own checkpoints, with each step's tool calls folded beneath it in mono. Add one quiet control, a note to the agent, delivered with its next call and then marked delivered. When the agent stops for a person, the red row carries that one action itself.
- Leave: Comment threads, which need resolving. A note is one line, delivered once.
- Sources: [Introducing Antigravity, November 2025](https://antigravity.google/blog/introducing-google-antigravity/), [Artifacts](https://antigravity.google/docs/artifacts/), [Screenshot](https://storage.googleapis.com/gweb-developer-goog-blog-assets/images/editor-open-agent-manager.original.png) (Per-agent awaiting-approval marks are unverified.)

**Buildkite — queue details, and a pause that ends itself** (answers 1, 6, 8)

One queue page sets supply beside demand. Agents: in use, idle, paused, draining. Jobs: in progress, starting up, not runnable yet (waiting on a person, or on a dependency), scheduled and needing an agent. Pausing an agent takes a timeout and an optional note; jobs already started continue and new ones go elsewhere or wait. An agent that misses heartbeats for three minutes is marked lost.

- Borrow: Replace Dispatch RUNNING · Machines 3 · Free slots 10 with two lines of counts. Machines: in use, idle, paused. Work: in progress, starting, waiting on you (red), waiting on other work, waiting for a machine. An idle project then reads 3 idle, never grey cells. Pause dispatch keeps its guard but takes a duration and a note, and the band says who paused, why, and when it resumes.
- Leave: The donut, the percentile panel and the chart.
- Sources: [Queue metrics](https://buildkite.com/docs/pipelines/insights/queue-metrics), [Pausing and resuming an agent](https://buildkite.com/docs/agent/self-hosted/pausing-and-resuming), [Screenshot](https://buildkite.com/docs/assets/queue-metrics-overview-CMBq09gU.png)

**Vercel — Spend Management: a budget with a stop agreed in advance** (answers 4, 7, 8)

One amount per billing cycle, with alerts at 50, 75 and 100 percent. An opt-in action, pausing production, is confirmed once and then fires by itself when spend reaches the amount. Raising the amount resumes nothing; each project is resumed explicitly. Budget edits, pauses and resumes are recorded in the team's activity.

- Borrow: Move the daily token budget from Settings to the head of the sessions band, reading today's tokens against the limit in ink, with the agreed action named inside the existing guard. At the limit dispatch pauses itself, the line turns red and Start dispatch stands in place. Budget edits, automatic pauses and resumes join the day's run history.
- Leave: Keeping it on a billing page, and the typed-name confirmation. Merv's named-consequence guard already does that job.
- Sources: [Spend Management](https://vercel.com/docs/spend-management), [Pause by default, June 2024](https://vercel.com/changelog/spend-management-now-pauses-production-deployments-by-default) (Temporal was dropped (built around execution ids and attempt numbers), as was Modal (budgets on a billing page). Cursor's and Codex's dashboards are not documented.)

**Top pick.** Warp. It turns three pages into one list: each row is a unit of work, there are five status words of which exactly one means you, and time and spend sit on every row. The other cases fit inside it: Buildkite's counts and Vercel's budget on the band's head, Antigravity's ladder and note in the sidebar.

**What they share.** The row is the run of work, named by its goal, not the process, lease, machine or key. Status comes from a small set in which one state asks for a person, and time and spend sit on the row. Progress is the agent's own plan with raw calls folded underneath. Machines appear as capacity counts and are named only when broken. Intervention is graded (a note, a time-limited pause, a stop), each step says what keeps running and how it resumes, and every act is logged.

## I. Code

**Covers:** Code · the branch drawing · proposals and pull requests · the Code block on a record

**Job:** See how each unit of work's code stands against main, and act on the one that needs a person.

### Where it falls short

1. The drawing cannot be read without being taught: shapes, line styles and the red curve mean things nothing on the page says, lines cross, and no axis says what left to right means.
2. In the simple case, four accepted branches, the drawing adds nothing a list would not say.
3. A third state vocabulary (working, ready, conflicted, accepted, quarantined) with no visible next step for the two that need one.
4. No diff or file view in the app; a proposal reads +0 −0 across 0 files.
5. The way from a record to its code opens the whole drawing with nothing selected.
6. Internals show through: branch names built from ids, an Operations fold, commit hashes.

### Who does this better

**GitHub — the Branches page and its behind/ahead bar** (answers 1, 2, 3)

Each branch is a table row: name, updated, check status, a behind/ahead cell, its pull request. The behind/ahead cell is a two-sided bar on a centre divider: the left half is what main has that the branch lacks, the right half is the branch's own work, each with its count, scaled to the most-diverged branch so rows compare. The default branch's row carries a Default pill and a link counting the pull requests queued to merge. No left bar means it merges cleanly; no right bar means it is already merged; two large bars mean a likely conflict.

- Borrow: Replace the lanes with a hairline list: kind label, name, state pill and one fixed column holding a tiny split bar against main. Left is what has reached main since this unit's base; right is this unit's change not yet in main. Main's own top row reads how many are waiting to merge, and units fully in main have no right bar and sink, muted.
- Leave: Commit counts and branch names as the row's identity, the Stale tab, and delete and rename.
- Sources: [Viewing branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/viewing-branches-in-your-repository), [Branch lists (GitHub blog)](https://github.blog/news-insights/the-library/branch-lists/), [Screenshot](https://docs.github.com/assets/images/help/pull_requests/merge-queue-branches-page.png) (The bar's colours are unverified.)

**GitHub — the stack map in the merge box (stacked pull requests)** (answers 1, 3, 5)

Inside the merge box every pull request in the stack is a row, top down, joined by one vertical rail that ends in a hollow dot and a main pill; the one you are viewing is highlighted. Each row has a check mark, the title and a state pill. The header says that merging this also merges the two below, and the only button counts it: Merge stack 3. A conflict gets Resolve conflicts in place, and a stack badge beside the pull request's state opens the same map from the page header.

- Borrow: A unit's Code block, and any Now row that needs a person, shows this chain: this unit, the units it is based on, then main, joined by one hairline rail with state pills and this unit highlighted. One accent control states its reach (Merge 3). A remedy appears only in the state that needs it.
- Leave: Offering the control before the conflict is known. Users of the preview report a green merge button while a rebase is still needed.
- Sources: [Stacked pull requests, July 2026](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/), [About stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs), [Screenshot](https://github.blog/wp-content/uploads/2026/07/628819269-72b7da6d-d10f-44b3-9ba6-2034ca0fbe5d.jpg) (Pills for blocked or conflicted layers are unverified.)

**Sapling — the Interactive Smartlog** (answers 1, 2, 4)

Main is one dashed line that hides all history except the commits your work is based on, labelled with a grey pill. Your unpushed work curves off it and a You are here pill marks your position. A row is the commit's title and age, with its checks, pull-request state and comment count beneath. View changes opens the diff inside the tool, and a conflict turns the change list into the list of unresolved files.

- Borrow: Keep the dotted main but cut it down to the points where units fork. Hang unmerged units off those points, and collapse units already in main into one muted line instead of curves. State is a pill under the name, never a node's shape, and a unit's diff opens in place.
- Leave: Drag-and-drop rebasing, buttons that appear only on hover, and pull-request numbers.
- Sources: [Interactive Smartlog](https://sapling-scm.com/docs/addons/isl), [Smartlog overview](https://sapling-scm.com/docs/overview/smartlog), [Screenshot](https://sapling-scm.com/img/isl/isl_overview_light.png) (GitButler was dropped as a developer's drag-based workspace, though it lists which branches will conflict before an update. Graphite was dropped: GitHub's stack map now matches it.)

**Trunk Merge Queue — the queue and its graph view** (answers 1, 3, 5)

The page is headed by the repository and the branch it merges into. The Queue view has two sections, waiting to enter the queue (with a Not ready pill and an age) and merged. In the Graph view each node is a pull request and every edge points toward the target branch; with no parallel work it is a single line. Hovering highlights a node's path to the root, and clicking opens that pull request's details, which list what must happen before it can enter the queue.

- Borrow: If any drawing survives, edges only point toward main and a linear history draws as straight rows, so four accepted branches become a list. Selecting a unit opens only its unmet conditions and the one control. Conflicted units leave the drawing for the Conflicted chip's own list.
- Leave: Section subtitles that explain, the health metrics and the activity panel.
- Sources: [Monitor queue status](https://docs.trunk.io/merge-queue/using-the-queue/monitor-queue-status), [Screenshot](https://mintcdn.com/trunk-4cab4936/_uqom5T5LPXKKAze/assets/merge-queue/using-the-queue/merge-queue-screen.png) (What the graph's nodes contain is unverified.)

**Top pick.** GitHub's stack map in the merge box. It is GitHub's own diagram, nothing in it drags, and it needs no legend: each row states itself in a word and main labels the end of the rail. It puts where the work stands against main and the one control that counts what will land in the same box. Pair it with the Branches bar for the overview of many units.

**What they share.** None of the strong products makes the reader decode a Git graph. They draw one relation, distance from main, with main as a labelled row or pill and history hidden. Each unit gets one row that states its state in a word. The single remedy appears on that row only when its state needs it, and the button counts what it will do. Selecting navigates; nothing drags.

## J. Settings and administration

**Covers:** Introduction · Members · Integrations · Keys · Connections · Plugins · Session

**Job:** Configure the project and my account: who may enter, what agents may touch, keys, integrations, budgets.

### Where it falls short

1. Scopes are mixed: project settings, account-wide things (keys of other projects, a personal provider token), system internals (68 plugins) and a grab-bag called Session.
2. The spending control is a bare number under Session, with no usage history, no remaining-today and no alert.
3. Membership works by exchanging account IDs. No invitation, no pending state, and the four roles are unexplained words.
4. Keys show no last use and no scope; two differently shaped creation controls; dates wrap into three columns.
5. Introduction is really the standing brief every agent receives: misnamed, unstructured and several screens long.
6. Connections is an empty room with no step to take; Plugins is developer diagnostics.
7. The GitHub card is the best-made surface in Settings. It is the standard for the rest.

### Who does this better

**Linear — settings grouped by scope, and Members** (answers 1, 3, 6)

Settings is its own page with Back to app. Its sub-navigation is grouped by scope: Account, Features, Administration (admins only) and Your teams. Members is one table (name, email, role, joined, last seen) grouped by state, filterable to pending invites, with one primary control, Invite people. An invite takes addresses and a role and is sent; a role changes through the row's own menu.

- Borrow: Group the settings sub-navigation under two uppercase scope labels: Project (Brief, Members, Integrations, Limits) and Account (my keys, provider tokens, theme, sign out). Plugins moves to an operator-only group nobody else sees. Members is one hairline list in which an invitation is a row with an invited pill and its age, sent to an address or as a link that carries one role and expires.
- Leave: The permanent workspace-wide link and joining by email domain. A Merv invitation names one role and expires.
- Sources: [Invite members](https://linear.app/docs/invite-members), [Members and roles](https://linear.app/docs/members-roles), [Screenshot](https://webassets.linear.app/images/ornj730p/production/a313a96cc77381626c08d431120991776b6041d6-3312x1732.png) (Tailscale's invite links carry a role and expire after 30 days unused.)

**Stripe — API keys: restricted keys and rotation** (answers 4)

A restricted key starts from a preset, from nothing, or from a duplicate of another key. The secret is shown once, with a note field asking where it was stored. Rotate key asks when the old key should stop working, now or up to seven days during which both work, and the time left then shows under the old key's name. Each key's menu offers its request log and Expire key. Creation asks what the key is for; a key for an agent needs approval for sensitive actions.

- Borrow: One New key control that asks for project, role and expiry, in place of two differently shaped ones. Each key is a one-line row: name, scope as a kind label, a state pill (active, expiring, expired), expiry and last call as relative times. The row opens that key's calls. Replace key offers an overlap window and the old row counts down under its name.
- Leave: The per-resource permission matrix. Merv grants a role in a project.
- Sources: [API keys](https://docs.stripe.com/keys), [Restricted API keys](https://docs.stripe.com/keys/restricted-api-keys) (A last-used column is unverified.)

**Vercel — Spend Management** (answers 2)

The budget is one row: a ring gauge, spend against the limit as two numbers and a percentage, and a toggle. The section sets the budget and what happens as it is used: alerts at 50, 75 and 100 percent, a webhook, and pausing production, which is confirmed by typing the team's name. Raising the budget does not unpause anything, and every change, pause and resume is recorded in the team's activity.

- Borrow: Replace the bare number under Session with one row in Project › Limits: a small ring, tokens used against the limit for today, when it resets, and a paused pill once dispatch stops at the cap. The row unfolds in place to the thresholds and the at-cap action, Pause dispatch, guarded like Merv's other stops.
- Leave: The explanatory paragraph and the red ring. Red already means two things in Merv.
- Sources: [Spend Management](https://vercel.com/docs/spend-management), [Screenshot](https://7nyt0uhk7sse4zvn.public.blob.vercel-storage.com/docs-assets/static/docs/concepts/teams/spend-manage-light.png) (OpenAI's project limits and alerts were confirmed, but no display of spend against the limit could be.)

**Devin — Knowledge: standing instructions as a list of items** (answers 5)

Standing instructions are a list of items, each with a name, a line saying when it applies and short content. An item is pinned to no repository, one, or all, and can be switched off without deleting it. Devin suggests new items and changes to existing ones from feedback in chat; under Suggestions the person edits, dismisses or accepts each before it is saved.

- Borrow: Rename Introduction to Brief and draw it as a hairline list of short named sections (problem, corpus, budget, harness, operator notes), each with its audience as a small label, unfolding in place and edited on its own. Changes an agent proposes arrive as amber proposal rows showing the change. Sections Merv regenerates each cycle are told apart from person-written ones by position, not by a sentence.
- Leave: Retrieval by relevance. In a review-gated system every agent's brief must be fixed and inspectable.
- Sources: [Knowledge](https://docs.devin.ai/product-guides/knowledge)

**Claude — Connectors and their tool permissions** (answers 1, 6, 7)

Connected services are listed together, and each opens to disconnect it, change its settings or review its access; a plus opens a directory of what can be added. A connector's tools are grouped by type (read-only, write or delete), and each group is set to Always allow, Needs approval or Blocked. An administrator's limit on a connector cannot be overridden by an individual.

- Borrow: Integrations becomes the one room for every outside system, each drawn with the GitHub card's layout; the Hugging Face token moves there from Session. A provider not yet connected is the same card with one Connect control, so the room is never empty. Agent access becomes a three-state control per group of tools (Allowed, Needs you, Blocked), and the project's setting is a ceiling no session can raise.
- Leave: Per-conversation toggles and a marketplace by category. Merv has a handful of integrations.
- Sources: [Use connectors to extend Claude](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)

**Top pick.** Devin's Knowledge. The brief is the only setting that changes what every agent does, and today it is the hardest room to read. Named, scoped sections that are edited one at a time, with agent-proposed changes as proposals, make it auditable and fit Merv's existing amber proposal kind.

**What they share.** The strongest products make scope the first level of structure: whose setting this is, with administrative rooms hidden from everyone else. Every credential, budget and invitation is a row showing its current state (spend against limit, time to expiry, pending, last activity) rather than a bare field. The consequence sits on the control: an overlap window when rotating, a typed name before a pause, a three-way choice per group of tools. In-between states (invited, expiring, suggested) live in the same list as settled ones.

## K. Reading and detail grammar

**Covers:** Every page: agent-written text · how detail opens · state words · counts · finding a thing by name

**Job:** Make pages written mostly by agents readable at a glance, and make selecting a thing behave the same everywhere.

### Where it falls short

1. No tiers of reading. Nothing gives the 30-second version (the outcome, the numbers that matter, what failed) before the full text.
2. Numbers and names inside agent prose are not lifted out into facts you can scan.
3. Long lists of like things (cited files, bundle parts, retired agents) are printed in full.
4. Four detail patterns for one act, and selection sometimes moves the page thousands of pixels.
5. About eleven words for finished (done, complete, approved, accepted, pass, met, succeeded, released, retired, closed, applied) and six for in motion.
6. Truncation hides the sentence that matters.
7. With no search across collections, finding a known thing by name means knowing which page holds it.

### Who does this better

**Sentry — issue details: highlights first, long lists in drawers** (answers 1, 2, 3, 4)

An Event Highlights block sits above the evidence and shows a fixed set of values from the event; the set is chosen once per project and applies to every issue. The full sections follow, each collapsible. Breadcrumbs show a few rows and View all, which opens a slide-out drawer with search, filter and sort while the issue stays visible behind it. Tags and activity open into drawers too.

- Borrow: Give each record kind a fixed highlights row under its title, filled from fields the agent submits rather than mined from prose: for an experiment the outcome sentence, the metric against baseline and the verdict; for a review, 2 of 4 not met with the failed checks first. Cited files, bundle parts, tool calls and retired agents show three hairline rows and All 22, which opens the shared detail panel without moving the page.
- Leave: Letting each person edit which highlights show. Fix the set per kind.
- Sources: [New issue details, February 2025](https://sentry.io/changelog/new-issue-details-ui-now-available/), [Highlights on issues, 2024](https://sentry.io/changelog/improved-tags-and-contexts-on-issues/), [Screenshot](https://cslswue7zohm4cat.public.blob.vercel-storage.com/0HI1E6k-issue-highlights.png)

**Semantic Reader — skimming highlights instead of a summary** (answers 1, 2, 6)

It does not summarise. Key sentences are highlighted in place, tinted by role, with the role word in the margin (Goal, Method, Result), and spread so most paragraphs carry one. A side panel lists the highlighted sentences. In the study behind it, readers found target information significantly faster at comparable accuracy, and the authors argue that summaries are error-prone and cut readers off from the text.

- Borrow: The producing agent marks up to three sentences in each long text (a verdict, a conclusion, a check note, the brief) as outcome, number or failure. Collapsed views show those sentences, never the first line and an ellipsis. Expanded text keeps them tinted, with a small uppercase role word in the margin like a kind label.
- Leave: Four facet colours with density and opacity sliders. That is a colour code that needs a legend.
- Sources: [Semantic Reader](https://www.semanticscholar.org/product/semantic-reader), [The Scim paper](https://arxiv.org/abs/2205.04561), [Screenshot](https://cdn.prod.website-files.com/605236bb767e9a5bb229c63c/651de22d27e3d289f4ef51f8_v2-sidepanel.png)

**GitHub — one side panel for issues, project items and agent sessions** (answers 4)

Clicking an item on a project board opens it in a side panel over the project; a modifier-click opens the full page in a new tab. The panel shows the same issue view as the issue's own page, not a cut-down card. Since April 2026 agent sessions open in that same sidebar, from an issue or from the board, with progress and logs.

- Borrow: One right-docked panel for every selection: Work and Now rows, Running cards, Home's drawing, Sessions, Files. It shows the record's own page at panel width while the list, board or drawing stays where it is with the selection outlined. A glyph opens the full page; at phone width the panel is the page.
- Leave: Editing everything inside the panel. Merv keeps at most one control there.
- Sources: [Sessions in the side panel, April 2026](https://github.blog/changelog/2026-04-23-view-and-manage-agent-sessions-from-issues-and-projects/), [Issues side panel, 2024](https://github.blog/changelog/2024-01-18-github-issues-projects-project-status-updates-issues-side-panel/) (Whether the open panel has its own address is unverified. Notion's side peek was dropped: each view chooses panel, modal or page, which is the inconsistency Merv has today.)

**GOV.UK Design System — task-list statuses** (answers 1, 5)

Start with the fewest statuses that might work and add one only when needed. Completed is plain text with no tag, so tags draw the eye only to tasks that need action. Cannot start yet is grey text on a row that is not a link, and red is reserved for errors. The whole row is the link, because people tried to click the status.

- Borrow: Every finished state (done, complete, approved, accepted, merged, retired) shows as plain secondary text with no pill. Only a state that asks something of the person wears one. Waits on X is grey and is not a control.
- Leave: The coloured in-progress tag: teal is Merv's task and experiment kind colour.
- Sources: [Complete multiple tasks](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/), [Task list component](https://design-system.service.gov.uk/components/task-list/) (The same clash exists for red, which is both the reviews and reflections kind colour and the needs-you colour.)

**Jira — status categories, and search that starts with recent items** (answers 5, 7)

Teams may create any number of statuses, but each must belong to To do, In progress or Done, and that category, with a fixed colour, drives lists, boards and reports. To find a known item, the search field lists recent items of every type before you type, then matches names and text as you type.

- Borrow: Keep each kind's precise word on its own record (Met, Pass, Merged) but map it to one of four shared categories: not started, with an agent, needs you, finished. The category alone sets the pill, the grouping on Now and Work, and what a count beside a title counts, which ends Reflections 0 over a list of one. Finding by name would be a plain field that lists recently opened records and matches names across collections; that reopens the ruling that removed the rail's search line, so it is the founder's call.
- Leave: Query commands and any overlay summoned by a shortcut. A field finds records, never commands.
- Sources: [What is a workflow status](https://support.atlassian.com/jira-cloud-administration/docs/what-is-a-workflow-status/), [Find recent work items](https://support.atlassian.com/jira-software-cloud/docs/find-recent-work-items/)

**Top pick.** Sentry. It is the closest analogue: a machine-generated record read under time pressure. Its two mechanics, a fixed highlights row per kind and lists that show a few rows and open into a drawer, fix the reading problems in Merv's hairline language without adding controls.

**What they share.** The best products decide, for each kind of object, what the 30-second version is: a fixed set of facts plus the sentences that carry the outcome. They show it first and in place, built from structured data rather than a generated summary. Long lists of like items shrink to a few rows and a count, all detail opens in one panel that never moves the page, and colour goes only on states that ask for action.

## Across the product

Eight ideas recur across the eleven categories. They are the short list to argue about before any one page is redrawn.

1. **Outcome first, process below.** An experiment opens on its result, a review on its verdict and what failed, a reflection on what was learned, Home on what changed. Evidence, rounds, lenses and history follow. (Hugging Face, SafetyCulture, eLife, Sentry Seer, Discourse.)
2. **Typed facts instead of files and prose.** A metric is a value on the record with how far it has been checked; a proposed task is a row; a cited passage is an excerpt. Most of the borrowings above need agents to submit a few structured fields (the result, the sentences that matter, the plan's steps), which is a change to the tools as much as to the pages.
3. **One small set of states, one of which means you.** Keep each kind's precise word on its record but map all of them to not started, with an agent, needs you, finished. Finished wears no pill. The same state shows the same way on Home, Now, Work and Running. (Warp, Devin, Sentry, GOV.UK, Jira.)
4. **One docked panel for detail.** Every selection, on a list, a board or a drawing, opens the record's own page in the same right-hand panel and never moves the page. The Agent docks the same way, carrying the record on screen as a chip. (GitHub's side panel and Copilot panel.)
5. **Time on state.** How long an item has been where it is, what changed since your last visit, and a mark that ages by itself. Stalled work then shows without a sentence. (Linear, Google Drive, Basecamp.)
6. **Proposals are objects that become the work.** A reflection's change specification, an agent's drafted tasks, a suggested edit to the brief, and a chat action all arrive as amber proposal rows or a filled form, and turn into the live record in place. (Sentry Seer, Jira, Shopify Sidekick, Devin.)
7. **Intervention scaled to consequence.** A read is silent, a reversible write is one sentence and one button, an irreversible act lists what it will touch. Between doing nothing and halting sit a note to the agent and a pause that ends itself, and the budget carries a stop agreed in advance. (Atlassian Rovo, Buildkite, Vercel, Stripe.)
8. **Scope is the first structure.** The project's name is a switcher that opens where it stands and keeps your page; Now with no project chosen is the view across projects; Settings splits into Project and Account. (Vercel, Slack, Linear.)

Four borrowings touch standing rulings and are the founder's call: a field for finding a record by name reopens the removal of the rail's search line; red is today both the reviews and reflections colour and the needs-you colour; notifications outside the app and a view across projects are new capabilities. Everything here is inspiration; docs/UI_DESIGN.md remains the contract. Links were checked on 1 October 2026 (two eLife pages refuse automated requests and open normally in a browser). Screenshots of Merv are from the seeded demo, except Agent chat, which is from a QA project.
