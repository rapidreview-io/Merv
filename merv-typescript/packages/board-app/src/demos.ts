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
const words = (text: string, at: At, size: string, say?: string) => ({
  op: 'text',
  text,
  size,
  at,
  ...(say && { say }),
});
/** A few pen strokes, in board coordinates. */
const draw = (paths: string[], say?: string, color?: string) => ({
  op: 'sketch',
  size: 'native',
  at: [0, 0],
  strokes: paths.map((path) => ({ path, width: 'medium', ...(color && { color }) })),
  ...(say && { say }),
});
const line = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} L${x2} ${y2}`;
const circle = (x: number, y: number, r: number) =>
  `M${x - r} ${y} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
const rect = (x: number, y: number, w: number, h: number) =>
  `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`;
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
  title: 'AI note takers',
  ask: "What's out there for AI note takers?",
  calls: [
    [words('AI note takers', [0, 0], 'l', "Four names you'll hear the most.")],
    company(
      70,
      'granola.png',
      'Granola',
      'no bot, records on your computer',
      'Granola records on your laptop, so nothing shows up in the call.',
    ),
    company(
      170,
      'otter.png',
      'Otter',
      'joins the call, live transcript',
      'Otter joins the call. People mostly use it for the live transcript.',
    ),
    company(
      270,
      'fireflies.png',
      'Fireflies',
      'joins the call, sends notes to Salesforce',
      'Fireflies joins too, and sends the notes to Salesforce and tools like that.',
    ),
    company(
      370,
      'fathom.png',
      'Fathom',
      'joins the call, has a free plan',
      'Fathom joins too. People like the free plan.',
    ),
    [
      words(
        'Is there a bot in the call?',
        [640, 10],
        'm',
        talk(
          'They all sound the same to me.',
          'Pretty much. The big difference is whether a bot shows up in your call.',
        ),
      ),
    ],
    [
      draw(call(640), "Here's a normal call."),
      draw(robot(800), 'With most of them, this guy sits in it with you.', 'red'),
      words('Bot', [640, 240], 'm'),
      words('Otter, Fireflies, Fathom', [640, 275], 's'),
      words('everyone sees it, hooks into your tools', [640, 300], 's'),
    ],
    [
      draw(call(1070), "With Granola it's just the people on the call."),
      words('No bot', [1070, 240], 'm'),
      words('Granola', [1070, 275], 's'),
      words(
        'you have to tell people yourself',
        [1070, 300],
        's',
        "Nobody can see it, so it's on you to say you're recording.",
      ),
    ],
    [
      words(
        'Talk to people who quit one',
        [640, 360],
        'm',
        talk("So where's the gap?", "No idea yet. I'd go ask people who quit using one."),
      ),
      draw(Array.from({ length: 10 }, (_, i) => stick(660 + i * 60)).flat(), 'Ten is plenty.'),
    ],
    [
      words('Why did you stop?', [640, 510], 's', 'Ask why they stopped.'),
      words(
        'Does work let you use a bot?',
        [860, 510],
        's',
        'And whether work even lets them bring a bot.',
      ),
    ],
    [
      words(
        'First: find 10 of them',
        [640, 560],
        'l',
        talk('Okay, what do I do first?', 'Find those ten people. I can help with the questions.'),
      ),
    ],
  ],
};

/** Who made what: a thing's name, and the people behind it. */
const kind = (x: number, y: number, name: string, who: string, say?: string) => [
  words(name, [x, y], 'm'),
  words(who, [x, y + 35], 's', say),
];
const person = (x: number, y: number) => [
  circle(x, y, 8),
  line(x, y + 8, x, y + 32),
  line(x - 10, y + 18, x + 10, y + 18),
  line(x, y + 32, x - 8, y + 48),
  line(x, y + 32, x + 8, y + 48),
];
/** Someone asleep, with a car in their dream. */
const dreaming = (x: number, y: number) => [
  circle(x + 30, y + 80, 28),
  line(x + 16, y + 78, x + 26, y + 78),
  line(x + 36, y + 78, x + 46, y + 78),
  circle(x + 68, y + 52, 4),
  circle(x + 84, y + 40, 7),
  circle(x + 160, y + 45, 55),
  `M${x + 125} ${y + 55} L${x + 135} ${y + 35} L${x + 180} ${y + 35} L${x + 195} ${y + 55} Z`,
  circle(x + 140, y + 60, 6),
  circle(x + 180, y + 60, 6),
];
/** Moves looked ahead from where it stands. */
const moves = (x: number, y: number) =>
  [50, 120, 190].flatMap((dx) => [
    line(x + 120, y + 14, x + dx, y + 60),
    circle(x + dx, y + 66, 6),
    line(x + dx, y + 72, x + dx - 18, y + 108),
    line(x + dx, y + 72, x + dx + 18, y + 108),
  ]);
/** A picture of a hill with a piece hidden, and the piece guessed in words. */
const hidden = (x: number, y: number) => [
  rect(x, y, 170, 120),
  `M${x} ${y + 95} Q${x + 20} ${y + 72} ${x + 40} ${y + 60}`,
  `M${x + 95} ${y + 44} Q${x + 135} ${y + 58} ${x + 170} ${y + 90}`,
  circle(x + 140, y + 28, 12),
  rect(x + 40, y + 20, 55, 50),
  line(x + 180, y + 60, x + 225, y + 60),
  line(x + 225, y + 60, x + 213, y + 52),
  line(x + 225, y + 60, x + 213, y + 68),
];
/** A game on a screen, and the controller that steers it. */
const game = (x: number, y: number) => [
  rect(x, y, 190, 115),
  line(x + 10, y + 95, x + 90, y + 95),
  line(x + 115, y + 70, x + 180, y + 70),
  ...person(x + 45, y + 45),
  rect(x + 215, y + 55, 100, 55),
  line(x + 232, y + 82, x + 254, y + 82),
  line(x + 243, y + 71, x + 243, y + 93),
  circle(x + 280, y + 75, 5),
  circle(x + 298, y + 90, 5),
];
/** A room seen from its open side, with someone in it. */
const room = (x: number, y: number) => [
  rect(x, y, 210, 125),
  rect(x + 50, y + 28, 110, 68),
  line(x, y, x + 50, y + 28),
  line(x + 210, y, x + 160, y + 28),
  line(x, y + 125, x + 50, y + 96),
  line(x + 210, y + 125, x + 160, y + 96),
  ...person(x + 105, y + 55),
];

/** An arrow along a line, its head where it ends. */
const pointing = (x1: number, y1: number, x2: number, y2: number) => {
  const back = x2 < x1 ? 14 : -14;
  return [line(x1, y1, x2, y2), line(x2, y2, x2 + back, y2 - 9), line(x2, y2, x2 + back, y2 + 9)];
};
const eye = (x: number, y: number) => [
  `M${x} ${y + 45} Q${x + 70} ${y - 15} ${x + 140} ${y + 45} Q${x + 70} ${y + 105} ${x} ${y + 45} Z`,
  circle(x + 70, y + 45, 18),
];
/** Frames in a row, the last of them still a guess. */
const frames = (x: number, y: number) => [
  rect(x, y + 15, 55, 60),
  rect(x + 70, y + 15, 55, 60),
  rect(x + 140, y + 15, 55, 60),
];
const wheel = (x: number, y: number) => [
  circle(x + 70, y + 45, 45),
  circle(x + 70, y + 45, 9),
  line(x + 25, y + 45, x + 61, y + 45),
  line(x + 79, y + 45, x + 115, y + 45),
  line(x + 70, y + 54, x + 70, y + 90),
];
/** A monster, and the shot it should have fired. */
const monster = (x: number, y: number) => [
  circle(x + 45, y + 65, 40),
  circle(x + 30, y + 55, 6),
  circle(x + 60, y + 55, 6),
  `M${x + 25} ${y + 85} Q${x + 45} ${y + 72} ${x + 65} ${y + 85}`,
  line(x + 95, y + 65, x + 155, y + 65),
];

/** Several papers explained, with who wrote them, ending on which to read first. */
const worldModels: Demo = {
  title: 'World models',
  ask: "What's a world model? Everyone seems to mean something different.",
  calls: [
    [
      words(
        'World models',
        [0, 0],
        'l',
        "It's an AI's guess at what happens next. People build them for different reasons.",
      ),
    ],
    [words('Help an AI decide', [0, 70], 'm', 'Some are there to help an AI decide.')],
    [
      draw(
        dreaming(0, 110),
        'Ha and Schmidhuber trained an agent inside its own dream, then let it into the real game.',
      ),
      ...kind(
        0,
        245,
        'Practice in a dream',
        'Ha & Schmidhuber, 2018; Hafner (Dreamer), 2019',
        'Danijar Hafner took that much further with Dreamer.',
      ),
    ],
    [
      draw(moves(490, 110), "MuZero doesn't care what the game looks like."),
      ...kind(
        490,
        245,
        'Only what helps it win',
        'Schrittwieser, Silver (MuZero), DeepMind, 2019',
        'It only predicts what helps it win, and that was enough for Go and chess.',
      ),
    ],
    [
      draw(hidden(980, 110), 'Yann LeCun thinks predicting every pixel is a waste.'),
      words('?', [1040, 145], 'm'),
      words(
        'a hill, probably',
        [1215, 155],
        's',
        'So you hide part of a picture and guess the gist.',
      ),
      ...kind(980, 245, 'Skip the pixels', 'LeCun, 2022; Assran (I-JEPA), Meta, 2023'),
    ],
    [
      words(
        'Make a world you can see',
        [0, 350],
        'm',
        talk(
          'And the ones that make videos?',
          'Different job. These make a world you can look at.',
        ),
      ),
    ],
    [
      draw(game(0, 390), 'Genie watched videos of games online, and you can play what it makes.'),
      ...kind(0, 525, 'Video you can play', 'Bruce, Parker-Holder (Genie), DeepMind, 2024'),
    ],
    [
      draw(room(490, 390), "Fei-Fei Li's company makes 3D places you can walk around in."),
      ...kind(490, 525, 'A 3D place to walk in', 'Fei-Fei Li (Marble), World Labs, 2025'),
    ],
    [
      words(
        'Read first: Ha & Schmidhuber',
        [980, 440],
        'm',
        talk(
          'Which one should I read first?',
          "Ha and Schmidhuber. It's short, and you can play with it.",
        ),
      ),
      draw([line(0, 302, 180, 302), line(0, 307, 180, 307)], 'Start with this one.', 'red'),
    ],
    [
      words(
        'How the dream works',
        [-1100, 60],
        'l',
        talk("Okay, let's go with that. Zoom in on it.", 'Sure. There are three parts to it.'),
      ),
      draw(pointing(-10, 190, -260, 190), "Here's what's inside that dream.", 'red'),
    ],
    [
      draw(eye(-1100, 125), 'First, eyes. They squeeze the screen into 32 numbers.'),
      words('Eyes', [-1100, 240], 'm'),
      words('squeeze the screen', [-1100, 275], 's'),
      words('into 32 numbers', [-1100, 300], 's'),
    ],
    [
      draw(frames(-820, 125), 'Then memory. It guesses what those numbers will be next.'),
      words('?', [-672, 165], 'm', 'That guess is the dream.'),
      words('Memory', [-820, 240], 'm'),
      words('guesses the next', [-820, 275], 's'),
      words('32 numbers', [-820, 300], 's'),
    ],
    [
      draw(wheel(-540, 125), "Last, hands. Just 867 numbers, so they're easy to train."),
      words('Hands', [-540, 240], 'm'),
      words('just 867 numbers', [-540, 275], 's'),
      words('choose what to do', [-540, 300], 's'),
    ],
    [
      draw(
        dreaming(-1100, 370),
        'So they trained the hands inside the dream, with no real game running.',
      ),
      words('Train in the dream', [-1100, 505], 'm'),
    ],
    [
      draw(
        monster(-820, 370),
        talk(
          "Couldn't it just cheat?",
          "It did. It found a way to stop the dream's monsters from ever shooting.",
        ),
      ),
      draw([line(-740, 420, -680, 450), line(-740, 450, -680, 420)], undefined, 'red'),
      words('It cheated', [-820, 505], 'm'),
      words('so they made', [-820, 540], 's'),
      words(
        'the dream messier',
        [-820, 565],
        's',
        'So they made the dream messier, and harder to fool.',
      ),
    ],
    [
      draw(game(-540, 370), 'Then they put it in the real game for the first time.'),
      words('The real game', [-540, 505], 'm'),
      words('750 steps to pass', [-540, 540], 's'),
      words(
        'it lasted about 1100',
        [-540, 565],
        's',
        'It needed 750 steps to pass. It lasted about 1100.',
      ),
    ],
  ],
};

export const DEMOS: Demo[] = [worldModels, market];
