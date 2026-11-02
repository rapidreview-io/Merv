/**
 * What the landing page plays: a person asks, and the agent answers on the board, explaining as it
 * goes. Each is ordinary board content, one call a thought, as Pi is told to draw. An image names a
 * file in ../assets, which the server keeps as a file of the host project when it draws the demo.
 */
export interface Demo {
  title: string;
  /** What the person says first, printed before anything is drawn. */
  ask: string;
  /** The operations of each call, in order. */
  calls: object[][];
}

/** A line as a demo plays it: what the person says, printed as they say it, then the agent's answer. */
const talk = (person: string, agent: string) => `${person}\n${agent}`;
type At = [number, number];
const words = (text: string, at: At, size: string, say?: string, color?: string) => ({
  op: 'text',
  text,
  size,
  at,
  ...(say && { say }),
  ...(color && { color }),
});
/** A few pen strokes, in board coordinates. */
const draw = (paths: string[], say?: string, color?: string, width = 'medium') => ({
  op: 'sketch',
  size: 'native',
  at: [0, 0],
  strokes: paths.map((path) => ({ path, width, ...(color && { color }) })),
  ...(say && { say }),
});
const line = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} L${x2} ${y2}`;
const circle = (x: number, y: number, r: number) =>
  `M${x - r} ${y} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
const rect = (x: number, y: number, w: number, h: number) =>
  `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`;
/** A straight arrow, and its head. */
const arrow = (x1: number, y1: number, x2: number, y2: number) => {
  const turn = Math.atan2(y2 - y1, x2 - x1);
  const head = (by: number) =>
    `L${(x2 - 12 * Math.cos(turn + by)).toFixed(1)} ${(y2 - 12 * Math.sin(turn + by)).toFixed(1)}`;
  return [line(x1, y1, x2, y2), `M${x2} ${y2} ${head(0.5)}`, `M${x2} ${y2} ${head(-0.5)}`];
};

/** A famous paper, on the board, and the one idea in it, sketched. */
const pentagon = Array.from({ length: 5 }, (_, i) => {
  const turn = (i / 5) * 2 * Math.PI - Math.PI / 2;
  return [640 + 62 * Math.cos(turn), 410 + 62 * Math.sin(turn)] as [number, number];
});
const paper: Demo = {
  title: 'Attention Is All You Need, explained',
  ask: 'I keep hearing about this paper. Can you explain it like I am new to this?',
  calls: [
    [
      {
        op: 'image',
        asset: 'attention-page.png',
        at: [0, 0],
        width: 340,
        alt: 'First page of Attention Is All You Need',
        say: 'Here is the paper. There is one idea in it that matters, so let us start there.',
      },
    ],
    [
      words(
        'Older models read one word at a time',
        [400, 0],
        'm',
        'Older models read a sentence one word at a time, and long sentences wear them out.',
      ),
    ],
    [
      draw([0, 1, 2, 3, 4].map((i) => circle(420 + i * 90, 75, 14))),
      draw([0, 1, 2, 3].flatMap((i) => arrow(438 + i * 90, 75, 488 + i * 90, 75))),
    ],
    [
      words(
        'The animal didn’t cross the street because it was too tired.',
        [400, 135],
        'm',
        talk('Wear them out how?', 'Take this sentence. What does the word it mean?'),
      ),
    ],
    [
      draw(
        ['M866 172 Q670 262 474 172', 'M474 172 L492 174', 'M474 172 L484 188'],
        'You know it means the animal. The model has to work that out.',
        'red',
      ),
      words('it = the animal', [600, 235], 's', undefined, 'red'),
    ],
    [
      words(
        'This paper: every word looks at every other word, at once.',
        [400, 295],
        'm',
        talk(
          'So what does this paper do differently?',
          'Every word looks at every other word, all at once.',
        ),
      ),
    ],
    [
      draw(pentagon.map(([x, y]) => circle(x, y, 11))),
      draw(
        pentagon.flatMap((a, i) => pentagon.slice(i + 1).map((b) => line(a[0], a[1], b[0], b[1]))),
        'That looking is what they call attention.',
        'blue',
        'thin',
      ),
    ],
    [
      words(
        'How a word knows where to look',
        [0, 520],
        'm',
        talk(
          'How does a word know where to look?',
          'Each word asks a question: what am I looking for?',
        ),
      ),
      draw([circle(50, 600, 26), line(69, 619, 100, 650)]),
      words('Query: what am I looking for?', [0, 670], 's'),
    ],
    [
      draw(
        [
          circle(330, 600, 18),
          line(348, 600, 410, 600),
          line(390, 600, 390, 618),
          line(405, 600, 405, 618),
        ],
        'Every other word holds up a key: what do I have to offer?',
      ),
      words('Key: what do I have to offer?', [290, 670], 's'),
    ],
    [
      draw(
        [
          rect(590, 590, 70, 55),
          line(580, 590, 670, 590),
          line(625, 590, 625, 645),
          'M625 590 Q600 560 590 585',
          'M625 590 Q650 560 660 585',
        ],
        'Where they match, that word’s meaning is passed along.',
      ),
      words('Value: what gets passed along', [550, 670], 's'),
    ],
    [
      words('1    2    3', [865, 575], 's'),
      draw(
        [0, 1, 2].map((i) => circle(872 + i * 44, 625, 11)),
        talk(
          'If it reads everything at once, how does it know word order?',
          'Good catch. The order is added to each word.',
        ),
      ),
      words('Word order is added in', [840, 670], 's'),
    ],
    [
      words(
        'Why it mattered',
        [0, 740],
        'm',
        'With no word-by-word reading, training runs in parallel, which made it far faster.',
      ),
      draw(arrow(10, 810, 170, 810)),
      words('before: one at a time', [0, 830], 's'),
      draw([790, 805, 820, 835].flatMap((y) => arrow(310, y, 470, y))),
      words('now: all together, much faster', [300, 850], 's'),
      words('and it beat the best translators of its day', [600, 805], 's'),
    ],
    [
      words(
        'G',
        [300, 920],
        'l',
        talk(
          'Wait. Is this the T in GPT?',
          'Yes. Generative pretrained transformer. It started here.',
        ),
      ),
      words('P', [360, 920], 'l'),
      words('T', [420, 920], 'l'),
      draw([circle(434, 942, 42), ...arrow(482, 942, 570, 942)], undefined, 'red'),
      words('the Transformer, from this paper', [580, 925], 'm'),
    ],
  ],
};

/** A video call, as a window of faces. */
const call = (x: number) => [
  rect(x, 75, 230, 150),
  ...[50, 115].flatMap((dx) => [
    circle(x + dx, 130, 22),
    `M${x + dx - 10} ${136} Q${x + dx} ${148} ${x + dx + 10} ${136}`,
  ]),
];
const robot = (x: number) => [
  rect(x, 110, 44, 40),
  circle(x + 13, 125, 4),
  circle(x + 31, 125, 4),
  line(x + 12, 140, x + 32, 140),
  line(x + 22, 110, x + 22, 94),
  circle(x + 22, 90, 4),
];
const stick = (x: number) => [
  circle(x, 430, 10),
  line(x, 440, x, 472),
  line(x - 12, 452, x + 12, 452),
  line(x, 472, x - 10, 492),
  line(x, 472, x + 10, 492),
];
/** One row of the market map: its logo and, in hand, the one thing to know. */
const company = (y: number, asset: string, name: string, fact: string, say: string) => [
  { op: 'image', asset, at: [0, y], width: 52, alt: `${name} logo`, say },
  words(name, [68, y], 'm'),
  words(fact, [68, y + 30], 's'),
];

/** Market research with a person, ending on what to go and find out. */
const market: Demo = {
  title: 'AI note takers: who is out there',
  ask: 'I am thinking of building an AI note taker. Help me understand who is already out there.',
  calls: [
    [
      words(
        'AI meeting note takers',
        [0, 0],
        'l',
        'Let us map it. Here are four you will run into first.',
      ),
    ],
    company(
      70,
      'granola.png',
      'Granola',
      'runs on your computer, no bot in the call',
      'Granola records from your own computer, so nothing joins the call.',
    ),
    company(
      170,
      'otter.png',
      'Otter',
      'joins your meetings, known for live transcripts',
      'Otter joins your meetings and is known for live transcripts.',
    ),
    company(
      270,
      'fireflies.png',
      'Fireflies',
      'a bot joins, sends notes into tools like Salesforce',
      'Fireflies sends a bot and pushes notes into sales tools.',
    ),
    company(
      370,
      'fathom.png',
      'Fathom',
      'a bot joins by default, known for its free plan',
      'Fathom joins by default too, and is known for its free plan.',
    ),
    [
      words(
        'One question splits them: does a bot join your call?',
        [640, 10],
        'm',
        talk(
          'They sound the same to me. What is the real difference?',
          'One question splits this market. Does a bot join your call?',
        ),
      ),
    ],
    [
      draw(call(640), 'Picture a normal call.'),
      draw(robot(800), 'With most of them, a bot sits in the call with you.', 'red'),
      words('A bot joins', [640, 240], 'm'),
      words('Otter, Fireflies, Fathom', [640, 275], 's'),
      words('everyone sees it, but it plugs into work tools', [640, 300], 's'),
    ],
    [
      draw(call(1070), 'With Granola, there is nobody extra.'),
      words('No bot', [1070, 240], 'm'),
      words('Granola', [1070, 275], 's'),
      words('discreet, but you must tell people yourself', [1070, 300], 's'),
    ],
    [
      words(
        'So what do we go and find out?',
        [640, 360],
        'm',
        talk(
          'So where is the opening for me?',
          'I would not guess yet. Here is what I would go and find out.',
        ),
      ),
      draw(
        Array.from({ length: 10 }, (_, i) => stick(660 + i * 60)).flat(),
        'Find ten people who stopped using one.',
      ),
    ],
    [
      words('Why did you stop?', [640, 510], 's', 'Ask why they stopped.'),
      words(
        'Are you even allowed to bring a bot to work?',
        [860, 510],
        's',
        'And whether they are allowed to bring a bot at all.',
      ),
    ],
    [
      words(
        'Next: talk to ten people who stopped.',
        [640, 560],
        'l',
        talk('Okay. Who should I talk to first?', 'Those ten people. Let us write the questions.'),
      ),
    ],
  ],
};

export const DEMOS: Demo[] = [paper, market];
