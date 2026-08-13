/**
 * Roster and setup content for the "Connect your agent" onboarding.
 *
 * Six clients ship a native Merv integration with browser OAuth (README
 * "Hosted setup"): Codex, Claude Code, Gemini CLI, Cursor, Kilo, and Hermes.
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
    maker: 'OpenAI’s coding agent',
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
    maker: 'Anthropic’s coding agent',
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
    maker: 'Google’s coding agent',
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
    maker: 'Cursor’s terminal agent',
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
    maker: 'Kilo’s coding agent',
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
    maker: 'Nous Research’s agent',
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
];

export const OTHER_CLIENT_NAMES = [
  'OpenCode',
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
  claude: 'clients/claude.svg',
  gemini: 'clients/gemini.svg',
  cursor: 'clients/cursor.svg',
  kilo: 'clients/kilo.svg',
  hermes: 'clients/hermes.svg',
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
