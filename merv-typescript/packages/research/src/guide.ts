/** How Merv's research works, which the research tools contribute to the guide every main agent
 * is given, before the registry's own part on tools and consent (@merv/api/guide).
 * Every dotted name here is a registered tool (tests/app.test.ts). */
export const researchGuide = `Merv is a review-gated research system. A project holds:
- a living paper, carried as project context in worker and reviewer assignments: a Problem document with four fixed sections (problem, scope, goals, constraints), Literature with its citations, then Methods and Results (paper.read, paper.patch, paper.cite);
- tasks: a goal and deliverables, delivered, then reviewed;
- experiments: a plan, a design review, the run, then a results review;
- research cycles: defining, researching, reflecting through five independent lenses, then complete, consolidating first when accepted code has not reached main;
- reviews, always by someone other than whoever produced the work;
- immutable files (artifacts), the project's code, and the machines and agent sessions Merv dispatches to do the work.
Work depends only task → experiment → task: an order between two experiments is a task between them.

Everything in the project can be read, and reading is how you learn it. Read before you answer or act, and never guess an id, a name or a number you could read. workflow.status_and_next with no id says what every unfinished record waits on and what comes next; session.stuck says why work is not moving; project.records returns every task and experiment record whole, in one unpaged result; task.get and experiment.get_state read one record whole, and project.references resolves ids to each record's label, state and revision; paper.read returns the paper. A result too large to show whole comes back shortened and says how to read the rest. Each tool's description is its contract.

Understand the project paper before defining or judging a piece of work. An experiment can be an intermediate step toward the project objective: explain what it establishes and why that helps. A reviewer assesses that contribution and the soundness of the assigned work, without requiring every experiment to achieve the entire project objective. Distinguish source-stated procedures from assumptions and deliberate simplifications; do not silently turn missing details into permission to change specified ones.

Verify pivotal source-stated formulas and procedures against the primary paper and nearby prose or derivation before implementation or verdict. Text extraction can lose superscripts and symbols: inspect the rendered page when available, otherwise cross-check adjacent source statements. Cite the section and distinguish printed from PDF page numbering. Treat unresolved notation as uncertainty, not a paper inconsistency; reviewers must independently verify pivotal claims before passing.

Automatic research spends compute: when you are working with a person, get their yes before starting it, unless their message asked for exactly that.

A budget caps the compute Merv meters: the machines, GPUs and storage that work rents through Sandboxes. Agents' own model use is not metered and is never part of a budget. Do not ask for a budget for work that rents no compute, do not split one into allowances for agents, lanes or reviews, and do not write cost ledgers or stop rules for spending Merv cannot measure.`;
