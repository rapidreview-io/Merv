/**
 * What the Running page is given, as the owners will send it: a board of five pieces of
 * work, four things in the sessions band and four machines — one Fleet machine already
 * folded into its session, one sandbox folded into a Code check, a done task that Code
 * still holds, and a session and a sandbox that need a person — and the sidebars of a
 * task, a session and a sandbox. Every instant is measured from the moment it is built,
 * so a test reads the clocks it expects whatever time it runs at. The ids carry the
 * prefixes the page must never print.
 */
import type {
  RunningBoard,
  RunningEdge,
  RunningLane,
  RunningNode,
  RunningPanel,
} from '@merv/contracts/running';

const step = (state: string, current = false, terminal = false) => ({
  state,
  initial: state === 'in_progress',
  terminal,
  current,
  entries: 0,
  firstEnteredAt: null,
  blockers: [],
});
const way = (from: string, to: string) => ({
  from,
  action: `${from}_${to}`,
  to,
  traversals: [],
  status: null,
  tool: null,
  blockers: [],
});
const graph = {
  instanceId: 'wf_index',
  workflow: 'task',
  version: 6,
  revision: 3,
  state: 'in_progress',
  currentGate: 'delivery_required',
  terminal: false,
  nodes: [step('in_progress', true), step('in_review'), step('done', false, true)],
  edges: [
    way('in_progress', 'in_review'),
    way('in_review', 'in_progress'),
    way('in_review', 'done'),
  ],
  dependencies: [],
};

export function board(now = Date.now()): RunningBoard {
  const at = (ms: number) => new Date(now + ms).toISOString();
  const node = (over: Partial<RunningNode> & Pick<RunningNode, 'key' | 'lane' | 'title'>) =>
    ({ lines: [], look: 'solid', ...over }) as RunningNode;
  const work: RunningNode[] = [
    node({
      key: 'work:wf_table',
      lane: 'work',
      kind: 'Task',
      title: 'Sensitivity table',
      look: 'quiet',
      lines: [[], ['Done']],
      attention: {
        says: ['Waiting on a person to merge the pull request'],
        who: 'A signed-in operator',
        to: { route: '/code', text: 'Merge reviewed proposal' },
      },
      owner: 'tasks',
    }),
    node({
      key: 'work:wf_index',
      lane: 'work',
      kind: 'Task',
      title: 'Rebuild citation index',
      lines: [['Producer on it']],
      dot: 'moving',
      owner: 'tasks',
    }),
    node({
      key: 'work:wf_review',
      lane: 'work',
      kind: 'Task',
      title: 'Review citation index',
      look: 'dashed',
      lines: [['Waits on Rebuild citation index']],
      links: [{ to: 'work:wf_index', verb: 'waits on', waiting: true }],
      owner: 'tasks',
    }),
    node({
      key: 'work:wf_ablate',
      lane: 'work',
      kind: 'Experiment',
      title: 'Ablate retrieval depth',
      lines: [[{ state: 'running' }, ' · ', { since: at(-7_200_000) }]],
      dot: 'live',
      owner: 'experiments',
    }),
    node({
      key: 'work:wf_draft',
      lane: 'work',
      kind: 'Task',
      title: 'Draft section 3.2 from the ablation results, with one figure',
      look: 'dashed',
      lines: [['Waits on Ablate retrieval depth'], ['Ready once it settles']],
      links: [{ to: 'work:wf_ablate', verb: 'waits on', waiting: true }],
      dot: 'starting',
      owner: 'tasks',
    }),
  ];
  const sessions: RunningNode[] = [
    node({
      key: 'session:session_ablate',
      lane: 'sessions',
      title: 'Ablate retrieval depth',
      lines: [['Last call ', { ago: at(-2_040_000) }], ['on a Fleet VM']],
      dot: 'live',
      attention: {
        says: ['Quiet ', { since: at(-2_040_000) }],
        who: 'An operator halts the lease.',
      },
      links: [{ to: 'work:wf_ablate', verb: 'works on' }],
      aliases: ['fleet:flt_bound'],
      owner: 'sessions',
    }),
    node({
      key: 'session:session_index',
      lane: 'sessions',
      title: 'Rebuild citation index',
      lines: [[{ mono: 'code.commit' }, ' · ', { since: at(-12_000) }], ['on mac-studio']],
      dot: 'moving',
      links: [{ to: 'work:wf_index', verb: 'works on' }],
      owner: 'sessions',
    }),
    node({
      key: 'session:session_draft',
      lane: 'sessions',
      title: 'Draft section 3.2',
      look: 'dashed',
      lines: [['Starting · ', { since: at(-40_000) }]],
      dot: 'starting',
      links: [{ to: 'work:wf_draft', verb: 'works on', waiting: true }],
      owner: 'sessions',
    }),
    node({
      key: 'fleet:flt_spare',
      lane: 'sessions',
      title: 'Fleet VM',
      look: 'dashed',
      lines: [['Starting · ', { since: at(-120_000) }]],
      dot: 'starting',
      links: [{ to: 'work:wf_draft', verb: 'rented for' }],
      owner: 'fleet',
    }),
  ];
  const hardware: RunningNode[] = [
    node({
      key: 'sandbox:sbx_h100',
      lane: 'hardware',
      title: '8× H100',
      name: 'aurora-sweep',
      units: { count: 8, busy: true },
      lines: [
        ['Running ', { since: at(-1_860_000) }],
        [{ money: null, rate: { amount: '32.40', currency: 'USD' } }],
      ],
      attention: {
        says: ['Lease ', { until: at(360_000) }],
        who: 'A producer or operator extends or releases it.',
      },
      owner: 'sandboxes',
    }),
    node({
      key: 'check:base_7a1e',
      lane: 'hardware',
      title: 'Code check',
      units: { count: 1, busy: true },
      lines: [
        ['Running ', { since: at(-180_000) }],
        [{ money: null, rate: { amount: '0.12', currency: 'USD' } }],
      ],
      links: [{ to: 'work:wf_table', verb: 'checks' }],
      aliases: ['sandbox:sbx_check'],
      owner: 'code-research',
    }),
    node({
      key: 'compute:c0ffee',
      lane: 'hardware',
      title: 'GPU run',
      name: 'k16-seed2',
      lines: [['Running ', { since: at(-720_000) }]],
      links: [{ to: 'work:wf_ablate', verb: 'runs for' }],
      owner: 'experiments',
    }),
    node({
      key: 'sandbox:sbx_a10',
      lane: 'hardware',
      title: 'A10',
      name: 'embed-refs',
      units: { count: 1, busy: false },
      lines: [
        ['Idle ', { since: at(-360_000) }],
        [{ money: null, rate: { amount: '0.75', currency: 'USD' } }],
      ],
      owner: 'sandboxes',
    }),
  ];
  const edges: RunningEdge[] = [
    { from: 'work:wf_review', to: 'work:wf_index', verb: 'waits on', waiting: true },
    { from: 'work:wf_draft', to: 'work:wf_ablate', verb: 'waits on', waiting: true },
    { from: 'session:session_ablate', to: 'work:wf_ablate', verb: 'works on', waiting: false },
    { from: 'session:session_index', to: 'work:wf_index', verb: 'works on', waiting: false },
    { from: 'session:session_draft', to: 'work:wf_draft', verb: 'works on', waiting: true },
    { from: 'fleet:flt_spare', to: 'work:wf_draft', verb: 'rented for', waiting: false },
    { from: 'check:base_7a1e', to: 'work:wf_table', verb: 'checks', waiting: false },
    { from: 'compute:c0ffee', to: 'work:wf_ablate', verb: 'runs for', waiting: false },
  ];
  const lane = (nodes: RunningNode[], over: Partial<RunningLane> = {}): RunningLane => ({
    nodes,
    summaries: [],
    needsYou: nodes.filter((item) => item.attention && !item.attention.quiet).length,
    failed: [],
    ...over,
  });
  return {
    observedAt: at(0),
    lanes: {
      work: lane(work),
      sessions: lane(sessions, {
        summaries: [
          // Sessions' own words, which every reader gets; the control is an operator's, and so
          // is the red clause of why work waits, which only an operator's read counts.
          {
            lane: 'sessions',
            says: [
              'Dispatch ',
              { state: 'running' },
              ' · Machines ',
              { count: 2 },
              ' · Free slots ',
              { count: 1 },
            ],
            actions: [
              {
                label: 'Pause dispatch',
                verb: 'pause',
                tool: 'session.dispatch',
                input: { enabled: false },
                allowed: true,
              },
            ],
            owner: 'sessions',
          },
        ],
      }),
      hardware: lane(hardware, { asOf: at(-4_000), freshForMs: 60_000 }),
    },
    edges,
  };
}

/** A board with nothing on it, whose lanes each say so. */
export const emptyBoard = (now = Date.now()): RunningBoard => ({
  observedAt: new Date(now).toISOString(),
  lanes: {
    work: { nodes: [], summaries: [], needsYou: 0, failed: [] },
    sessions: { nodes: [], summaries: [], needsYou: 0, failed: [] },
    hardware: { nodes: [], summaries: [], needsYou: 0, failed: [] },
  },
  edges: [],
});

export function taskPanel(now = Date.now()): RunningPanel {
  const at = (ms: number) => new Date(now + ms).toISOString();
  return {
    key: 'work:wf_index',
    observedAt: at(0),
    header: {
      kind: 'Task',
      title: 'Rebuild citation index',
      says: [{ state: 'in_progress' }, ' · producer on it · ', { since: at(-1_500_000) }],
    },
    sections: [
      { title: 'Progress', place: 'progress', kind: 'ladder', graph },
      {
        title: 'Sessions',
        place: 'activity',
        kind: 'links',
        rows: [
          {
            to: { key: 'session:session_index' },
            kind: 'Producer',
            name: 'Rebuild citation index',
            says: ['Last call ', { ago: at(-120_000) }],
          },
        ],
      },
      {
        title: 'Review',
        place: 'review',
        kind: 'facts',
        rows: [
          {
            label: 'Standing',
            value: [{ actor: 'actor_ana', prefix: 'With ', unnamed: 'Claimed' }],
          },
          { label: 'Claimed', value: [{ ago: at(-900_000) }] },
          {
            label: 'Verdict page',
            value: [{ link: { route: '/reviews/review_1' }, text: 'Open the review' }],
          },
        ],
      },
      {
        title: 'Unblocks',
        place: 'relations',
        kind: 'links',
        rows: [
          {
            to: { key: 'work:wf_review', route: '/tasks/wf_review' },
            kind: 'Task',
            name: 'Review citation index',
            says: [{ state: 'in_progress' }],
          },
        ],
      },
      {
        title: 'Code',
        place: 'code',
        kind: 'facts',
        rows: [
          { label: 'Branch', value: [{ mono: 'merv/task/rebuild-citation-index' }] },
          {
            label: 'Pull request',
            value: [{ link: { href: 'https://github.com/lab/paper/pull/212' }, text: '#212' }],
          },
        ],
      },
      {
        title: 'Details',
        place: 'details',
        kind: 'facts',
        rows: [{ label: 'Owner', value: [{ actor: 'actor_ana' }] }],
      },
    ],
    actions: [],
    route: '/tasks/wf_index',
    live: true,
  };
}

export function sessionPanel(now = Date.now()): RunningPanel {
  const at = (ms: number) => new Date(now + ms).toISOString();
  const call = (tool: string, ago: number, state = 'succeeded', ms: number | null = 400) => ({
    call: tool,
    state: state as 'succeeded',
    at: at(-ago),
    ms,
  });
  return {
    key: 'session:session_ablate',
    observedAt: at(0),
    header: {
      kind: 'Agent',
      title: 'Ablate retrieval depth',
      says: ['Active · Producer · ', { since: at(-2_520_000) }],
      attention: {
        says: ['Quiet ', { since: at(-2_040_000) }],
        who: 'An operator halts the lease.',
      },
    },
    sections: [
      {
        title: 'Merv calls',
        place: 'activity',
        kind: 'stream',
        aside: [{ count: 6, of: 19 }],
        total: 19,
        items: [
          { call: 'sandbox.exec', state: 'running', at: at(-2_050_000), ms: null },
          call('artifact.read', 2_100_000),
          call('artifact.read', 2_110_000),
          call('artifact.read', 2_120_000, 'succeeded', 8_400),
          call('code.commit', 2_700_000, 'failed', 1_200),
          { mark: ['Taken up'], at: at(-2_520_000) },
        ],
      },
      {
        title: 'Machine',
        place: 'machine',
        kind: 'facts',
        rows: [{ label: 'Machine', value: ['Fleet machine'] }],
      },
      {
        title: 'Fleet machine',
        place: 'machine',
        kind: 'facts',
        owner: 'fleet',
        rows: [
          { label: 'Status', value: [{ state: 'running' }] },
          { label: 'Time left', value: [{ until: at(3_060_000) }] },
        ],
      },
      {
        title: 'Brief',
        place: 'content',
        kind: 'text',
        text: '# Ablate retrieval depth\n\nRun k in {2, 4, 8, 16, 32} with three seeds each.',
        markdown: true,
        folded: true,
      },
      {
        title: 'Work',
        place: 'relations',
        kind: 'links',
        rows: [
          {
            to: { key: 'work:wf_ablate' },
            kind: 'Experiment',
            name: 'Ablate retrieval depth',
            says: [{ state: 'running' }],
          },
        ],
      },
    ],
    actions: [
      {
        label: 'Halt lease',
        verb: 'halt',
        tool: 'session.halt',
        input: { sessionId: 'session_ablate', reason: 'halted_by_operator' },
        allowed: true,
        guard: {
          title: 'Halt this lease?',
          consequence:
            'An agent holds this lease on Ablate retrieval depth as producer. Halting closes it now.',
        },
        expect: { field: 'halted', min: 1, nothing: 'Nothing was halted.' },
      },
    ],
    live: true,
    aliases: ['fleet:flt_bound'],
  };
}

export function sandboxPanel(now = Date.now(), withRelease = true): RunningPanel {
  const at = (ms: number) => new Date(now + ms).toISOString();
  return {
    key: 'sandbox:sbx_h100',
    observedAt: at(0),
    header: {
      kind: 'Sandbox',
      title: 'aurora-sweep',
      says: ['Running · ', { since: at(-1_860_000) }],
      attention: {
        says: ['Lease ', { until: at(360_000) }],
        who: 'A producer or operator extends or releases it.',
      },
    },
    sections: [
      {
        title: 'Now',
        place: 'progress',
        kind: 'facts',
        rows: [
          {
            label: 'Lease',
            value: [{ until: at(360_000), of: 7200 }],
            attention: true,
          },
          {
            label: 'Cost',
            value: [
              {
                money: { amount: '16.74', currency: 'USD' },
                rate: { amount: '32.40', currency: 'USD' },
              },
            ],
          },
          { label: 'Next job', value: [{ until: at(60_000) }] },
        ],
      },
      {
        title: 'Jobs',
        place: 'activity',
        kind: 'table',
        columns: ['Command', 'State', 'Started'],
        rows: [
          {
            cells: [
              [{ mono: 'python sweep.py --k 16' }],
              [{ state: 'running' }],
              [{ ago: at(-540_000) }],
            ],
          },
          {
            cells: [
              [{ mono: 'python sweep.py --k 8' }],
              [{ state: 'succeeded' }],
              [{ ago: at(-1_500_000) }],
            ],
          },
        ],
      },
    ],
    actions: [
      {
        label: 'Extend lease',
        verb: 'extend',
        tool: 'sandbox.extend',
        input: { id: 'sbx_h100', seconds: 3600 },
        allowed: true,
      },
      ...(withRelease
        ? [
            {
              label: 'Release machine',
              verb: 'release' as const,
              tool: 'sandbox.release',
              input: { id: 'sbx_h100' },
              allowed: true,
              guard: {
                title: 'Release this machine?',
                consequence: 'aurora-sweep stops now and its job with it.',
              },
            },
          ]
        : []),
    ],
    route: '/sandboxes/sbx_h100',
    live: true,
  };
}
