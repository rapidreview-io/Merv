// Transition controls follow the graph's evaluated edges, including its guards.
export function workflowActionButtons(workflow, primaryActions, secondaryActions) {
  const available = new Set((workflow?.available_actions || []).map(item => item.action));
  const suggested = workflow?.suggested_action?.action;
  return {
    primary: available.has(suggested) ? primaryActions[suggested] || null : null,
    secondary: secondaryActions.filter(item => available.has(item.transition)),
  };
}
