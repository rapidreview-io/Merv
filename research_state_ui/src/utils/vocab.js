// The one vocabulary: workflow ids → the words every surface uses for them.
// Raw ids belong in the Details drawer only. Unknown ids fall back to their
// snake_case as words, so a new backend state never renders blank.

export const words = (id) => String(id || '').replace(/_/g, ' ');

const STATES = {
  planned: 'Planned', design_review: 'Design review', ready_to_run: 'Ready to run', running: 'Running',
  experiment_review: 'Experiment review', complete: 'Complete', failed: 'Failed', abandoned: 'Abandoned',
  in_progress: 'In progress', in_review: 'In review', done: 'Done',
  reflecting: 'Reflecting', synthesizing: 'Synthesizing', reflection_review: 'Reflection review',
  consolidating: 'Consolidating', consolidation_review: 'Consolidation review', published: 'Published',
};
export const stateLabel = (id) => STATES[id] || words(id);

// Who judges each review state; also names the gate that state waits on.
export const REVIEWER_OF = {
  design_review: 'design_reviewer', experiment_review: 'experiment_reviewer', in_review: 'task_reviewer',
  reflection_review: 'reflection_reviewer', consolidation_review: 'consolidation_reviewer',
};

// 'design_reviewer' → 'design reviewer'; 'human' is the person reading the page.
export const roleLabel = (role) => (role === 'human' ? 'you' : words(role));

// The review a role performs: 'design_reviewer' → 'design review'. A role that
// already ends in "review" is left alone rather than doubled.
export function reviewKind(role) {
  const r = words(String(role || 'review').replace(/_reviewer$/, ''));
  return /review$/.test(r) ? r : `${r} review`;
}

const TRANSITIONS = {
  submit_design: 'Submit for design review', submit_results: 'Submit results for review',
  complete: 'Complete experiment', retry_running: 'Retry execution', abandon: 'Abandon', mark_failed: 'Mark failed',
  submit_delivery: 'Submit delivery for review', accept: 'Accept task',
};
export const transitionLabel = (id) => TRANSITIONS[id] || words(id);
export const transitionButton = (id) => ({ transition: id, label: transitionLabel(id) });

// Gate codes as the state of play, not as requirements.
export function gateLabel(code, state) {
  const reviewer = String(code || '').match(/^(\w+_reviewer)_required$/)?.[1];
  if (reviewer) return `Waiting for a ${roleLabel(reviewer)}`;
  return { plan_required: 'Plan not yet submitted', execution_ready: 'Execution in progress',
    results_report_required: 'Results report missing', logic_graph_required: 'Logic graph missing',
    review_not_requested: 'Review not yet requested', reflection_required: 'Reflection due',
    project_setup: 'Project setup', terminal: 'Finished' }[code] || (code ? words(code) : stateLabel(state));
}

// What the connected agent should be told next, as one pasteable sentence;
// null while the system is in motion (wait_*) or nothing is pending.
export function agentPrompt(nextAction, { state, name } = {}) {
  const a = String(nextAction || '');
  if (!a || a === 'none' || /^wait[_-]/.test(a)) return null;
  const who = name || 'this';
  return {
    request_review: `review the ${{ design_review: 'plan for', experiment_review: 'results of', in_review: 'delivery for',
      reflection_review: 'reflection', consolidation_review: 'consolidation for' }[state] || 'work for'} ${who}`,
    write_and_submit_plan: `write and submit the plan for ${who}`,
    run_experiment_and_retain_results: `run ${who} and retain its results`,
    write_and_submit_results_report: `write and submit the results report for ${who}`,
    write_and_submit_logic_graph: `submit the logic graph for ${who}`,
    create_claim_or_experiment: 'create the first claim or experiment',
    start_project_reflection_before_next_experiment: 'start a project reflection',
  }[a] || `${words(a)} for ${who}`;
}

// The one-line state of a record for lists and status statements:
// 'design_review' → 'design review · awaiting design reviewer'.
export function stateLine(state) {
  const reviewer = REVIEWER_OF[state];
  return stateLabel(state).toLowerCase() + (reviewer ? ` · awaiting ${roleLabel(reviewer)}` : '');
}
