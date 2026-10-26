/** How Merv's research works, which the research tools contribute to the guide every main agent
 * is given, before the registry's own part on tools and consent (@merv/api/guide).
 * Every dotted name here is a registered tool (tests/app.test.ts). */
export const researchGuide = `Merv is a review-gated research system. A project holds:
- a living paper, carried as project context in worker and reviewer assignments: a Problem document with four fixed sections (problem, scope, goals, constraints), Literature with its citations, then Methods and Results (paper.read, paper.write);
- tasks: a goal and deliverables, delivered, then reviewed;
- experiments: a plan, a design review, the run, then a results review;
- research cycles: defining, researching, reflecting through five independent lenses, then complete, consolidating first when accepted code has not reached main;
- reviews, always by someone other than whoever produced the work;
- immutable files (artifacts), the project's code, and the machines and agent sessions Merv dispatches to do the work.
Work depends only task → experiment → task: an order between two experiments is a task between them.

Everything in the project can be read, and reading is how you learn it. Read before you answer or act, and never guess an id, a name or a number you could read. workflow.read status with no id says what every unfinished record waits on and what comes next; session.read stuck says why work is not moving; project.read records indexes every task and experiment, and reads the ones its ids name whole; task.read get and experiment.read get read one record whole, and project.read references resolves ids to each record's label, state and revision; paper.read returns the paper. Some reads return only part of what they hold and say how to read the rest. Each tool's description is its contract.

Understand the project paper before defining or judging a piece of work. An experiment can be an intermediate step toward the project objective: explain what it establishes and why that helps. A reviewer assesses that contribution and the soundness of the assigned work, without requiring every experiment to achieve the entire project objective. Distinguish source-stated procedures from assumptions and deliberate simplifications; do not silently turn missing details into permission to change specified ones.

Verify pivotal source-stated formulas and procedures against the primary paper and nearby prose or derivation before implementation or verdict. Text extraction can lose superscripts and symbols: inspect the rendered page when available, otherwise cross-check adjacent source statements. Cite the section and distinguish printed from PDF page numbering. Treat unresolved notation as uncertainty, not a paper inconsistency; reviewers must independently verify pivotal claims before passing.

The only budget agents manage is the authorized GPU rental compute budget. Read Sandboxes spend for hardware-attributed GPU rental actuals and remaining lease commitments; count every GPU rental, including failed runs and GPUs used for CPU work. Preserve the authorization's scope: namespace lifetime spending is not automatically the spending of one experiment or wave. Reserve bounded rentals against the approved GPU allocation before admission. Independent experiments may rent GPUs concurrently within their allocations; a shared dollar cap is not an exclusive machine slot. Do not require an empty namespace or a dispatcher slot unless the experiment has an explicit resource constraint. Do not invent a missing native wave cap or demand additional approval for an already authorized allocation. Unknown GPU attribution must remain unknown, not zero.
`;
