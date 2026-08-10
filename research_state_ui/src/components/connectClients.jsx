/**
 * Roster and setup content for the "Connect your agent" onboarding.
 *
 * Four clients ship a native Merv plugin with browser OAuth (README "Hosted
 * setup"): Codex, Claude Code, Gemini CLI, and Cursor. Every other client —
 * OpenCode, Kilo, Hermes Agent, OpenHands, Replit Agent, and headless
 * runners/CI on MERV_MCP_KEY — is documented per client in the public repo.
 * The copy lives here, outside the wizard, so doc edits never touch flow
 * logic. Command strings must stay in lockstep with README.md and
 * merv/docs/CLIENTS.md.
 */

export const MERV_REPO_URL = 'https://github.com/NGXT-Inc/Merv';
export const CLIENT_DOCS_URL = `${MERV_REPO_URL}/blob/main/merv/docs/CLIENTS.md`;

// Consent guidance is shared: every native client ends in the same browser
// OAuth flow, and "All my projects" is what makes one sign-in permanent.
const CONSENT_NOTE =
  'Your browser opens Merv’s consent screen. Approve All my projects — one '
  + 'grant covers every project you belong to, and tokens refresh on their own.';

export const NATIVE_CLIENTS = [
  {
    id: 'codex',
    name: 'Codex',
    maker: 'OpenAI’s coding agent',
    steps: [
      {
        title: 'Install the plugin',
        commands: [
          'codex plugin marketplace add NGXT-Inc/Merv',
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
        note: 'Codex updates repository marketplaces explicitly — rerun these two when you want the latest.',
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
          'claude plugin marketplace add NGXT-Inc/Merv',
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
        note: 'In /plugin → Marketplaces → RapidReview, select Enable auto-update. Claude leaves third-party marketplaces manual by default.',
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
          'gemini extensions install https://github.com/NGXT-Inc/Merv --ref merv-client --auto-update',
        ],
        note: '--auto-update tracks the client branch, so the extension stays current on its own.',
      },
      {
        title: 'Sign in inside Gemini',
        commands: ['/mcp auth merv'],
        note: `Start gemini first, then run this. ${CONSENT_NOTE}`,
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
        commands: ['cursor-agent plugin marketplace add https://github.com/NGXT-Inc/Merv'],
      },
      {
        title: 'Install inside Cursor Agent',
        note: 'Start cursor-agent, open /plugin, choose the rapidreview marketplace, and install merv at user scope.',
      },
      {
        title: 'Connect',
        note: 'Select Connect for Merv under Customize — Cursor runs the browser sign-in. You never handle a key.',
      },
    ],
  },
];

export const OTHER_CLIENT_NAMES = [
  'OpenCode',
  'Kilo',
  'Hermes Agent',
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

/* Client marks: neutral 24-grid stroke glyphs in the sidebar icon language
   (fill none, currentColor, 1.8 stroke, round caps). No trademark artwork —
   a tile plus the client's name does the identifying. */
const MARKS = {
  codex: (
    <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
  ),
  claude: (
    <path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.6 6.6l2.8 2.8M14.6 14.6l2.8 2.8M17.4 6.6l-2.8 2.8M9.4 14.6l-2.8 2.8" />
  ),
  gemini: (
    <path d="M12 4c.6 4.4 3.6 7.4 8 8-4.4.6-7.4 3.6-8 8-.6-4.4-3.6-7.4-8-8 4.4-.6 7.4-3.6 8-8z" />
  ),
  cursor: (
    <path d="M6 4l13 6.5-5.6 1.7L11 18z" />
  ),
  other: (
    <>
      <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
};

export function ClientMark({ client, size = 30 }) {
  return (
    <span className="cnx-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width={size - 12}
        height={size - 12}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {MARKS[client] || MARKS.other}
      </svg>
    </span>
  );
}
