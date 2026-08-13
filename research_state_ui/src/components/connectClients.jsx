/**
 * Roster and setup content for the "Connect your agent" onboarding.
 *
 * Nine clients ship a native Merv integration with browser OAuth (README
 * "Hosted setup"): Codex, Claude Code, Gemini CLI, Cursor, Kilo, Hermes,
 * Qwen Code, Copilot CLI, and OpenCode.
 * Other clients and headless runners/CI are documented in the public repo.
 * The copy lives here, outside the wizard, so doc edits never touch flow
 * logic. Command strings must stay in lockstep with README.md and
 * merv/docs/CLIENTS.md.
 */

export const MERV_REPO_URL = 'https://github.com/rapidreview-io/Merv';
export const CLIENT_DOCS_URL = `${MERV_REPO_URL}/blob/main/merv/docs/CLIENTS.md`;

const CONSENT_NOTE = 'Approve All my projects in the browser.';

export const NATIVE_CLIENTS = [
  {
    id: 'codex',
    name: 'Codex',
    steps: [
      {
        title: 'Install the plugin',
        commands: [
          'codex plugin marketplace add rapidreview-io/Merv',
          'codex plugin add merv@rapidreview',
        ],
      },
      {
        title: 'Sign in from the terminal',
        commands: ['codex mcp login merv'],
        note: CONSENT_NOTE,
      },
      {
        title: 'Updating later',
        commands: [
          'codex plugin marketplace upgrade rapidreview',
          'codex plugin add merv@rapidreview',
        ],
        note: 'Rerun both commands to update.',
      },
    ],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    steps: [
      {
        title: 'Install the plugin',
        commands: [
          'claude plugin marketplace add rapidreview-io/Merv',
          'claude plugin install merv@rapidreview',
        ],
      },
      {
        title: 'Sign in from the terminal',
        commands: ['claude mcp login plugin:merv:merv'],
        note: CONSENT_NOTE,
      },
      {
        title: 'Once: turn on auto-update',
        note: 'In /plugin → Marketplaces → RapidReview, enable auto-update.',
      },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    steps: [
      {
        title: 'Install the extension',
        commands: [
          'gemini extensions install https://github.com/rapidreview-io/Merv --ref merv-client --auto-update',
        ],
        note: 'Updates automatically.',
      },
      {
        title: 'Sign in inside Gemini',
        commands: ['/mcp auth merv'],
        note: `Run inside Gemini. ${CONSENT_NOTE}`,
      },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    steps: [
      {
        title: 'Add the marketplace',
        commands: ['cursor-agent plugin marketplace add https://github.com/rapidreview-io/Merv'],
      },
      {
        title: 'Install inside Cursor Agent',
        note: 'In /plugin, install merv from rapidreview at user scope.',
      },
      {
        title: 'Connect',
        note: 'In Customize, select Connect for Merv.',
      },
    ],
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    steps: [
      {
        title: 'Install the plugin globally',
        commands: ["kilo plugin 'github:rapidreview-io/Merv#merv-client' --global"],
      },
      {
        title: 'Sign in from the terminal',
        commands: ['kilo mcp auth merv'],
        note: CONSENT_NOTE,
      },
      {
        title: 'Update this session',
        commands: ['/reload'],
        note: 'New sessions update automatically.',
      },
    ],
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    steps: [
      {
        title: 'Install the plugin',
        commands: ['hermes plugins install rapidreview-io/merv-hermes-client --enable'],
      },
      {
        title: 'Connect',
        commands: [
          'hermes mcp add merv --url https://experiments.rapidreview.io/mcp --auth oauth',
        ],
        note: CONSENT_NOTE,
      },
      {
        title: 'Updating later',
        commands: ['hermes plugins update merv'],
        note: 'Run when Merv announces an update.',
      },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    steps: [
      {
        title: 'Install the extension',
        commands: ['qwen extensions install rapidreview-io/Merv --ref=merv-client'],
      },
      {
        title: 'Sign in inside Qwen',
        commands: ['/mcp'],
        note: `Select Merv and sign in. ${CONSENT_NOTE}`,
      },
      {
        title: 'Updating later',
        commands: ['qwen extensions update merv'],
        note: 'Qwen prompts when an update is available.',
      },
    ],
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    steps: [
      {
        title: 'Install the plugin',
        commands: [
          'copilot plugin marketplace add rapidreview-io/Merv',
          'copilot plugin install merv@rapidreview',
        ],
      },
      {
        title: 'Sign in inside Copilot',
        commands: ['/mcp auth merv'],
        note: `Run inside Copilot. ${CONSENT_NOTE}`,
      },
      {
        title: 'Updating later',
        commands: ['copilot plugin update merv@rapidreview'],
      },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    steps: [
      {
        title: 'Install the plugin globally',
        commands: ["opencode plugin 'github:rapidreview-io/Merv#merv-client' --global"],
      },
      {
        title: 'Sign in from the terminal',
        commands: ['opencode mcp auth merv'],
        note: CONSENT_NOTE,
      },
      {
        title: 'Updating later',
        commands: ["opencode plugin 'github:rapidreview-io/Merv#merv-client' --global"],
        note: 'Skills update automatically.',
      },
    ],
  },
];

export const OTHER_CLIENT_NAMES = [
  'OpenHands',
  'Replit Agent',
];

export function clientById(id) {
  return NATIVE_CLIENTS.find((c) => c.id === id) || null;
}

// The first prompt to hand the agent. It must end in a project-scoped call
// (workflow.status_and_next) — that is the row the hosted activity ring can
// show a member, so it is also what the wizard's live check watches for.
export function verifyPrompt(projectName) {
  const pick = projectName
    ? `find the project named “${projectName}”`
    : 'pick the right project';
  return (
    'Use the merv MCP server: call project(action="list"), '
    + `${pick}, then call workflow.status_and_next with its project id `
    + 'and tell me what it suggests.'
  );
}

const CLIENT_ICONS = {
  codex: 'clients/codex.svg',
  copilot: 'clients/copilot.svg',
  claude: 'clients/claude.svg',
  gemini: 'clients/gemini.svg',
  qwen: 'clients/qwen.svg',
  cursor: 'clients/cursor.svg',
  kilo: 'clients/kilo.svg',
  hermes: 'clients/hermes.svg',
  opencode: 'clients/opencode.svg',
};

export function ClientMark({ client, size = 30 }) {
  const icon = CLIENT_ICONS[client];
  return (
    <span className="cnx-mark" style={{ width: size, height: size }} aria-hidden="true">
      {icon ? (
        <img src={`${import.meta.env.BASE_URL}${icon}`} alt="" />
      ) : (
        <svg viewBox="0 0 24 24" width={size - 12} height={size - 12}>
          <circle cx="5" cy="12" r="1.1" fill="currentColor" />
          <circle cx="12" cy="12" r="1.1" fill="currentColor" />
          <circle cx="19" cy="12" r="1.1" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}
