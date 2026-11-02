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
  ask: 'Explain the attention paper.',
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
  ask: 'Research the AI note taker market.',
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

/** The chance two of n people share a birthday, with every day equally likely. */
const shared = (n: number) => {
  let none = 1;
  for (let i = 0; i < n; i++) none *= (365 - i) / 365;
  return 1 - none;
};
const percent = (chance: number, places = 1) => `${(chance * 100).toFixed(places)}%`;
const AT_23 = shared(23);
const YOU_ALONE = 1 - (364 / 365) ** 22;
const room = Array.from({ length: 23 }, (_, i) => {
  const turn = (i / 23) * 2 * Math.PI - Math.PI / 2;
  return [270 + 170 * Math.cos(turn), 520 + 170 * Math.sin(turn)] as [number, number];
});
const between = (a: number, b: number) => {
  const [x1, y1] = room[a]!;
  const [x2, y2] = room[b]!;
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`;
};
const curveX = (n: number) => 620 + (n - 1) * 8.5;
const curveY = (chance: number) => 680 - chance * 300;
const curve = Array.from({ length: 60 }, (_, i) => i + 1)
  .map((n, i) => `${i ? 'L' : 'M'}${curveX(n).toFixed(1)} ${curveY(shared(n)).toFixed(1)}`)
  .join(' ');

/**
 * The run's result is real: 1,000,000 rooms of 23 with Python's random, seed 23, had 507,864 with a
 * shared birthday. The bar, the 6% and the curve are computed here from the exact formula.
 */
const birthday: Demo = {
  title: 'Is the birthday thing really 23?',
  ask: 'Is the birthday thing really 23?',
  calls: [
    [words('Really 23?', [0, 0], 'l', 'Let us not argue about it. Let us run it.')],
    [
      words(
        'ran it: 1,000,000 rooms of 23 people',
        [0, 65],
        'm',
        'I ran a million rooms of twenty three people, with random birthdays.',
      ),
    ],
    [
      draw([rect(0, 120, 700, 44), line(350, 112, 350, 172)]),
      draw(
        Array.from({ length: 35 }, (_, i) => `M${i * 10 + 4} 162 L${i * 10 + 12} 122`),
        '507,864 rooms had two people with the same birthday. A hair over half.',
        'red',
        'thin',
      ),
      draw([line(355.5, 120, 355.5, 164)], undefined, 'red', 'bold'),
      words('507,864 rooms', [720, 118], 'm', undefined, 'red'),
      words(`exact answer ${percent(AT_23, 2)}`, [720, 150], 's'),
      words('half', [335, 176], 's'),
    ],
    [
      draw(
        room.map(([x, y]) => circle(x, y, 8)),
        talk(
          'That can’t be right. There are 365 days.',
          'That is the trap. Here is the room. Now, picture yourself in it.',
        ),
      ),
    ],
    [
      draw(
        Array.from({ length: 22 }, (_, i) => between(0, i + 1)),
        'You can match 22 people. That is only about a six percent chance.',
        'red',
      ),
      words(`you: 22 chances, ${percent(YOU_ALONE, 0)}`, [0, 300], 'm', undefined, 'red'),
    ],
    [
      draw(
        Array.from({ length: 21 }, (_, a) =>
          Array.from({ length: 21 - a }, (_, b) => between(a + 1, a + b + 2)).join(' '),
        ),
        'But nobody said it has to be you. Any two people will do.',
        'gray',
        'thin',
      ),
      words('the room: 253 chances', [150, 720], 'l', 'Twenty three people make 253 pairs.'),
    ],
    [
      draw(
        [line(620, 380, 620, 680), line(620, 680, 1130, 680)],
        talk(
          'And with more people?',
          'It climbs fast, because pairs grow much faster than people.',
        ),
      ),
      draw([curve]),
      words('people in the room', [800, 695], 's'),
      words('chance', [628, 375], 's'),
      words('60', [1115, 695], 's'),
      words(`60 people: ${percent(shared(60), 0)}`, [960, 340], 's'),
    ],
    [
      draw(
        [
          circle(curveX(23), curveY(AT_23), 8),
          line(curveX(23), curveY(AT_23) + 8, curveX(23), 680),
        ],
        'And there is twenty three, right where the curve crosses half.',
        'red',
      ),
      words(`23: ${percent(AT_23)}`, [curveX(23) + 14, curveY(AT_23) + 6], 'm', undefined, 'red'),
    ],
    [
      words(
        'if every day is equally likely; real birthdays bunch up, which only helps',
        [620, 730],
        's',
        talk(
          'So it is real.',
          'It is real. And real birthdays bunch up, which only pushes it higher.',
        ),
      ),
    ],
  ],
};

/** A hand-drawn accuracy against log steps: it rises between these fractions of its width. */
const rising = (x: number, y: number, w: number, h: number, from: number, to: number) => {
  const a = x + from * w;
  const b = x + to * w;
  const top = y + 3;
  const foot = y + h - 3;
  return `M${x} ${foot} L${a} ${foot} C${(a + b) / 2} ${foot} ${(a + b) / 2} ${top} ${b} ${top} L${x + w} ${top}`;
};
const axes = (x: number, y: number, w: number, h: number) => [
  line(x, y, x, y + h),
  line(x, y + h, x + w, y + h),
];
/** A table with some cells seen and some not. */
const LEFT_OUT = new Set([2, 7, 9, 12, 14]);
const seenCells = Array.from({ length: 16 }, (_, i) => i).filter((i) => !LEFT_OUT.has(i));
const clock = Array.from({ length: 12 }, (_, i) => {
  const turn = (i / 12) * 2 * Math.PI - Math.PI / 2;
  return [640 + 80 * Math.cos(turn), 640 + 80 * Math.sin(turn)] as [number, number];
});

/**
 * What Power et al. 2022 (arXiv 2201.02177) show, in their numbers, with their Figure 1 (left). They
 * do not explain the switch: "two ways to be right" is the board's framing of their "memorized", and
 * the gradual inside is Nanda et al. 2023 (arXiv 2301.05217), on modular addition.
 */
const grokking: Demo = {
  title: 'Why did my model suddenly get it?',
  ask: 'Why did my model suddenly get it after 10k steps?',
  calls: [
    [
      words(
        'It might have grokked',
        [0, 0],
        'l',
        'That shape may have a name. I cannot see your run, so let us look at where it comes from.',
      ),
    ],
    [
      {
        op: 'image',
        asset: 'grokking-figure-1.png',
        at: [0, 65],
        width: 470,
        alt: 'Figure 1, left, of Power et al. 2022: train and validation accuracy against steps',
        say: 'This is the real figure from the paper. Red is training, green is held-out data.',
      },
      words('Power, Burda, Edwards, Babuschkin, Misra, 2022', [0, 435], 's'),
      words('arXiv 2201.02177, Figure 1 (left)', [0, 460], 's'),
    ],
    [
      draw(axes(540, 90, 500, 240), 'Let me draw just what matters in it.'),
      draw(
        [rising(540, 90, 500, 240, 0.2, 0.42)],
        'Training is near perfect before a thousand steps.',
        'red',
      ),
      words('train: near perfect before 1,000 steps', [640, 62], 's', undefined, 'red'),
    ],
    [
      draw(
        [rising(540, 90, 500, 240, 0.72, 1)],
        'Held-out data shows very little until a hundred thousand. Nothing to see for ages.',
        'green',
      ),
      words('validation: little until 100,000', [680, 270], 's', undefined, 'green'),
      draw([line(740, 330, 740, 340), line(940, 330, 940, 340)]),
      words('1,000', [720, 342], 's'),
      words('100,000', [910, 342], 's'),
      words(
        'steps, log scale, to 1,000,000',
        [540, 370],
        's',
        talk(
          'Mine took 10k, not a million.',
          'The number moves. In their runs, less data meant far more steps.',
        ),
      ),
    ],
    [
      words(
        'Two ways to be right',
        [0, 510],
        'm',
        talk(
          'But what could change when nothing changes?',
          'Perfect on training can mean two very different things.',
        ),
      ),
      draw(
        [
          rect(20, 560, 200, 200),
          ...[1, 2, 3].flatMap((i) => [
            line(20 + i * 50, 560, 20 + i * 50, 760),
            line(20, 560 + i * 50, 220, 560 + i * 50),
          ]),
        ],
        'Their task is a table of answers with holes in it.',
      ),
      draw(
        seenCells.map((i) => {
          const x = 45 + (i % 4) * 50;
          const y = 585 + Math.floor(i / 4) * 50;
          return `M${x - 8} ${y} L${x - 2} ${y + 8} L${x + 9} ${y - 9}`;
        }),
        'One way is to memorize the cells you were shown.',
      ),
      ...[...LEFT_OUT].map((i) =>
        words('?', [40 + (i % 4) * 50, 572 + Math.floor(i / 4) * 50], 'm', undefined, 'red'),
      ),
      words('memorized: the holes stay guesses', [0, 775], 's'),
    ],
    [
      draw(clock.map(([x, y]) => circle(x, y, 7))),
      draw(
        ['M640 560 A80 80 0 0 1 709 600', 'M709 600 L695 598', 'M709 600 L705 586'],
        'The other way is to find the rule, and that fills in every hole.',
        'red',
      ),
      words('found the rule: no holes', [540, 775], 's'),
      words('for modular addition they saw circles like this', [540, 800], 's'),
    ],
    [
      words(
        'Why it switches: this paper doesn’t say',
        [800, 510],
        'm',
        talk(
          'So why does it switch?',
          'This paper does not settle that. It did find weight decay helps a lot.',
        ),
      ),
      words('weight decay helped most', [800, 545], 's'),
      draw(axes(810, 590, 300, 110)),
      draw(
        ['M812 696 C840 590 880 600 950 610 C1000 620 1020 690 1060 696 L1108 696'],
        'A later paper looked inside. First comes memory.',
      ),
      words('memory', [840, 570], 's'),
      draw(
        ['M812 696 C900 690 980 660 1020 600 L1108 596'],
        'The rule grows quietly under it, and then the memory gets cleared out.',
        'red',
      ),
      words('rule', [1050, 570], 's', undefined, 'red'),
      words('later work, on modular addition (sketch, not data)', [800, 715], 's'),
      words('Nanda et al. 2023, arXiv 2301.05217', [800, 740], 's'),
    ],
    [
      words(
        'Check yours',
        [0, 850],
        'l',
        talk(
          'So is mine grokking?',
          'Maybe. They saw it on tiny math tables with little data. Check one thing first.',
        ),
      ),
      draw(
        axes(20, 920, 220, 90),
        'If training was perfect long before held-out moved, that is this shape.',
      ),
      draw([rising(20, 920, 220, 90, 0.05, 0.25)], undefined, 'red'),
      draw([rising(20, 920, 220, 90, 0.6, 0.95)], undefined, 'green'),
      words('train long before val: maybe', [20, 1020], 's'),
      draw(
        axes(420, 920, 220, 90),
        'If they rose together, it is ordinary learning. Then check your learning rate schedule.',
      ),
      draw([rising(420, 920, 220, 90, 0.5, 0.8)], undefined, 'red'),
      draw([rising(420, 923, 220, 87, 0.53, 0.85)], undefined, 'green'),
      words('together: not this', [420, 1020], 's'),
    ],
  ],
};

export const DEMOS: Demo[] = [birthday, grokking, paper, market];
