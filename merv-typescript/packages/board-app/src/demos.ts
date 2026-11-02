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
const note = (text: string, at: At, color: string, say?: string, key?: string) => ({
  op: 'note',
  text,
  at,
  color,
  ...(say && { say }),
  ...(key && { key }),
});
const box = (text: string, at: At, color: string, key: string, say?: string) => ({
  op: 'box',
  text,
  at,
  color,
  key,
  ...(say && { say }),
});

/** A famous paper, on the board, and the one idea in it. */
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
      words('The problem', [400, 0], 'm'),
      note(
        'Older models read a sentence one word at a time',
        [400, 45],
        'gray',
        'Older models read a sentence one word at a time, and long sentences wear them out.',
      ),
    ],
    [
      words(
        'The animal didn’t cross the street because it was too tired.',
        [400, 190],
        'm',
        talk('Wear them out how?', 'Take this sentence. What does the word it mean?'),
      ),
    ],
    [
      box('it', [820, 250], 'yellow', 'it'),
      box(
        'animal',
        [440, 250],
        'green',
        'animal',
        'You know it means the animal. The model has to work that out.',
      ),
      { op: 'arrow', from: 'it', to: 'animal', label: 'looks back at' },
    ],
    [
      words('The big idea', [400, 350], 'm'),
      note(
        'Every word looks at every other word, all at once. That is attention.',
        [400, 395],
        'blue',
        talk(
          'So what does this paper do differently?',
          'Every word looks at every other word, all at once.',
        ),
      ),
    ],
    [
      words('How a word knows where to look', [0, 560], 'm'),
      note(
        'Query: what am I looking for?',
        [0, 605],
        'yellow',
        talk(
          'How does a word know where to look?',
          'Each word asks a question: what am I looking for?',
        ),
      ),
      note(
        'Key: what do I have to offer?',
        [260, 605],
        'green',
        'Every other word holds up a label.',
      ),
      note(
        'Value: what I pass along',
        [520, 605],
        '#e9d5ff',
        'Where they match, that word’s meaning flows across.',
      ),
    ],
    [
      note(
        'Word order goes in as a signal added to each word',
        [780, 605],
        'orange',
        talk(
          'If it reads everything at once, how does it know word order?',
          'Good catch. The order is added to each word as a signal.',
        ),
      ),
    ],
    [
      words('Why it mattered', [0, 760], 'm'),
      note(
        'No word-by-word reading, so training runs in parallel',
        [0, 805],
        'green',
        'With no word-by-word reading, training runs in parallel, which made it far faster.',
      ),
      note(
        'It beat the best translation systems of its day',
        [260, 805],
        'green',
        'And it beat the best translation systems of its day.',
      ),
    ],
    [
      words(
        'This design is called the Transformer.',
        [560, 820],
        'l',
        talk(
          'Wait. Is this the T in GPT?',
          'Yes. Generative pretrained transformer. It started here.',
        ),
      ),
    ],
  ],
};

/** One row of the market map: its logo, its name, and the one thing to know. */
const company = (
  y: number,
  asset: string,
  name: string,
  fact: string,
  color: string,
  say: string,
) => [
  { op: 'image', asset, at: [0, y], width: 56, alt: `${name} logo`, say },
  words(name, [72, y + 12], 'm'),
  note(fact, [220, y - 6], color),
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
      'Runs on your computer. No bot in the call.',
      'green',
      'Granola records from your own computer, so nothing joins the call.',
    ),
    company(
      190,
      'otter.png',
      'Otter',
      'Joins your meetings. Known for live transcripts.',
      'blue',
      'Otter joins your meetings and is known for live transcripts.',
    ),
    company(
      310,
      'fireflies.png',
      'Fireflies',
      'A bot joins. Sends notes into tools like Salesforce.',
      '#e9d5ff',
      'Fireflies sends a bot and pushes notes into sales tools.',
    ),
    company(
      430,
      'fathom.png',
      'Fathom',
      'A bot joins by default. Known for a generous free plan.',
      'orange',
      'Fathom joins by default too, and is known for its free plan.',
    ),
    [
      words(
        'One question splits them',
        [640, 0],
        'm',
        talk(
          'They sound the same to me. What is the real difference?',
          'One question splits this market. Does a bot join your call?',
        ),
      ),
      box('A bot joins\nOtter, Fireflies, Fathom', [640, 60], 'blue', 'bot'),
      box('No bot\nGranola', [930, 60], 'green', 'free'),
    ],
    [
      note(
        'Everyone can see it, and it plugs into work tools',
        [640, 190],
        'blue',
        'A bot is visible to everyone, but it plugs into the tools a team already uses.',
      ),
      note(
        'Discreet, but you have to tell people yourself',
        [930, 190],
        'green',
        'No bot is discreet, but telling people they are recorded falls on you.',
      ),
    ],
    [
      words(
        'So what do we go and find out?',
        [640, 350],
        'm',
        talk(
          'So where is the opening for me?',
          'I would not guess yet. Here is what I would go and find out.',
        ),
      ),
      note(
        'Who has left a note taker, and why?',
        [640, 400],
        'yellow',
        'First, who has stopped using one, and why?',
      ),
      note(
        'Who is not allowed to use a bot at work?',
        [930, 400],
        'yellow',
        'Second, who is not allowed to bring a bot to work?',
      ),
    ],
    [
      words(
        'Next: talk to ten people who stopped.',
        [640, 540],
        'l',
        talk(
          'Okay. Who should I talk to first?',
          'Ten people who stopped using one. Let us write the questions.',
        ),
      ),
    ],
  ],
};

export const DEMOS: Demo[] = [paper, market];
