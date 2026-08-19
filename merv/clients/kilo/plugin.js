/** Native Kilo Code adapter for Merv's hosted MCP and remote skill catalog. */

export const MERV_MCP_URL = 'https://experiments.rapidreview.io/mcp';
export const MERV_SKILLS_URL = 'https://rapidreview.io/merv/.well-known/skills/';

const REVIEWERS = {
  'experiment-design-review': {
    description:
      'Read-only design reviewer for a fresh Merv design_reviewer handoff. '
      + 'Requires the experiment id, review request id, and reviewer capability.',
    prompt:
      'You are the independent Merv design reviewer. Load the '
      + '`experiment-design-review` skill and follow it exactly. Require the '
      + 'experiment id, review request id, and reviewer capability from the '
      + 'handoff. Do not edit files or run shell commands. Submit exactly one '
      + 'verdict through the Merv review tools.',
    permission: { edit: 'deny', bash: 'deny' },
  },
  'experiment-attempt-review': {
    description:
      'Read-only experiment reviewer for a fresh Merv experiment_reviewer handoff. '
      + 'Requires the experiment id, review request id, and reviewer capability.',
    prompt:
      'You are the independent Merv experiment reviewer. Load the '
      + '`experiment-attempt-review` skill and follow it exactly. Require the '
      + 'experiment id, review request id, and reviewer capability from the '
      + 'handoff. Do not edit files or run shell commands. Submit exactly one '
      + 'verdict through the Merv review tools.',
    permission: { edit: 'deny', bash: 'deny' },
  },
  'task-review': {
    description:
      'Read-only task reviewer for a fresh Merv task_reviewer handoff. '
      + 'Requires the task id, review request id, and reviewer capability.',
    prompt:
      'You are the independent Merv task reviewer. Load the '
      + '`task-review` skill and follow it exactly. Require the task id, '
      + 'review request id, and reviewer capability from the handoff. Verify '
      + 'each Done-when check against the delivery by checking, not by '
      + 'reading. Do not edit files. Submit exactly one verdict through the '
      + 'Merv review tools.',
    permission: { edit: 'deny' },
  },
  'project-reflection-review': {
    description:
      'Read-only reflection reviewer for a fresh Merv reflection_reviewer handoff. '
      + 'Requires the reflection id, review request id, and reviewer capability.',
    prompt:
      'You are the independent Merv project-reflection reviewer. Load the '
      + '`project-reflection-review` skill and follow it exactly. Require the '
      + 'reflection id, review request id, and reviewer capability from the '
      + 'handoff. Do not edit files or run shell commands. Submit exactly one '
      + 'verdict through the Merv review tools.',
    permission: { edit: 'deny', bash: 'deny' },
  },
  'consolidation-review': {
    description:
      'Read-only code-consolidation reviewer for a fresh Merv '
      + 'consolidation_reviewer handoff.',
    prompt:
      'You are the independent Merv code-consolidation reviewer. Load the '
      + '`consolidation-review` skill and follow it exactly. Require the '
      + 'reflection id, review request id, and reviewer capability from the '
      + 'handoff. Do not edit or commit. Read-only checks are allowed. Submit '
      + 'exactly one verdict through the Merv review tools.',
    permission: { edit: 'deny' },
  },
};

function appendUnique(values, value) {
  const current = Array.isArray(values) ? values : [];
  return current.includes(value) ? current : [...current, value];
}

export async function mervPlugin() {
  return {
    config: async (config) => {
      config.mcp = config.mcp || {};
      config.mcp.merv = {
        type: 'remote',
        url: MERV_MCP_URL,
        enabled: true,
      };

      config.skills = config.skills || {};
      config.skills.urls = appendUnique(config.skills.urls, MERV_SKILLS_URL);

      config.agent = config.agent || {};
      for (const [name, reviewer] of Object.entries(REVIEWERS)) {
        config.agent[name] = {
          ...(config.agent[name] || {}),
          description: reviewer.description,
          mode: 'subagent',
          prompt: reviewer.prompt,
          permission: {
            ...(config.agent[name]?.permission || {}),
            ...reviewer.permission,
          },
        };
      }
    },
  };
}

export default { id: 'merv', server: mervPlugin };
