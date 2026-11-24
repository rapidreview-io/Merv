/**
 * Five drawing traditions offered as agent guidance. Reference colours/fonts describe each
 * tradition; runtime rendering and drawing tools do not enforce them. Board paper is authored
 * separately and survives changes to this preference.
 */
export const LOOK_NAMES = ['khan', 'sketchnote', 'mindmap', 'sprint', 'blueprint'] as const;
export type LookName = (typeof LOOK_NAMES)[number];
/** The colour names every draw operation accepts, as this look's pens draw them. */
export type Named =
  'black' | 'red' | 'green' | 'blue' | 'yellow' | 'orange' | 'pink' | 'gray' | 'white';
/** Excalidraw's font families: 1 Virgil, 2 Helvetica, 3 Cascadia, 5 Excalifont, 6 Nunito, 7 Lilita One, 8 Comic Shanns, 9 Liberation Sans. */
export type Font = 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9;

export interface Look {
  name: LookName;
  title: string;
  /** Where the look comes from: what a person would recognise it as. */
  from: string;
  /** The canvas behind everything. */
  paper: string;
  /** The default pen, and a quieter one for frames and asides. */
  ink: string;
  soft: string;
  /** The outline of a box drawn without a fill. */
  outline: string;
  /** Named colours as this look's pens draw them; a name not here keeps its usual colour. */
  inks: Partial<Record<Named, string>>;
  paints: Partial<Record<Named, string>>;
  /** The sticky note a `note` with no colour gets. */
  note: Named;
  /** Body and heading fonts. */
  font: Font;
  heading: Font;
  /** Excalidraw's hand: 0 architect, 1 artist, 2 cartoonist. */
  rough: 0 | 1 | 2;
  /** The pen's width, in Excalidraw's thin, medium and bold. */
  width: 1 | 2 | 4;
  fill: 'solid' | 'hachure' | 'cross-hatch';
  /** Whether a filled box keeps its outline, as an engineering box does; a sticky note has none. */
  edge?: boolean;
  /** How to draw in it, one rule a line, for the agent whose board wears it. */
  sheet: string[];
  /** One ask whose answer shows whether an agent followed the look. */
  test: string;
}

export const LOOKS: Record<LookName, Look> = {
  khan: {
    name: 'khan',
    title: 'Khan',
    from: 'Khan Academy lessons: Sal Khan writing on black with bright pens, one colour per idea',
    paper: '#000000',
    ink: '#f5f5f5',
    soft: '#8d8d8d',
    outline: '#f5f5f5',
    inks: {
      black: '#f5f5f5',
      white: '#f5f5f5',
      red: '#ff6b6b',
      green: '#80ed99',
      blue: '#4cc9f0',
      yellow: '#ffd166',
      orange: '#ff9f43',
      pink: '#ff7eb6',
      gray: '#8d8d8d',
    },
    paints: {
      black: '#2a2a2a',
      white: '#f5f5f5',
      red: '#ff6b6b',
      green: '#80ed99',
      blue: '#4cc9f0',
      yellow: '#ffd166',
      orange: '#ff9f43',
      pink: '#ff7eb6',
      gray: '#555555',
    },
    note: 'yellow',
    font: 5,
    heading: 5,
    rough: 0,
    width: 2,
    fill: 'solid',
    sheet: [
      'Bright pens on black: white for ordinary writing, at most three accent colours a scene, and each quantity or idea keeps one colour wherever it appears, in its label, its drawing and its equation.',
      'Work like a page: three to five numbered steps down or to the right, the whole working shown, one worked example central with its explanation beside it.',
      'Smooth clean lines (no wobble): sketch strokes for graphs, number lines, fraction strips, braces and underlines, drawn large; titles 36 to 40, explanations 24 to 28, nothing under 20.',
      'Circle or box the answer in its own colour with a stroke; no sticky notes, no cards, no frames, no fills.',
      'Leave a third of the scene empty; a new problem starts a new column to the right.',
    ],
    test: 'Explain why 1/2 + 1/3 = 5/6 using fraction strips and three teaching steps.',
  },
  sketchnote: {
    name: 'sketchnote',
    title: 'Sketchnote',
    from: "Mike Rohde's Sketchnote Handbook, RSA Animate films by Cognitive, graphic recording at conferences",
    paper: '#fffcf5',
    ink: '#252525',
    soft: '#8d8d85',
    outline: '#252525',
    inks: {
      black: '#252525',
      red: '#c92a2a',
      yellow: '#e67700',
      blue: '#1971c2',
      green: '#2b8a3e',
      orange: '#e67700',
      pink: '#c92a2a',
      gray: '#8d8d85',
      white: '#ffffff',
    },
    paints: {
      yellow: '#ffe66d',
      red: '#ffc9c9',
      blue: '#a5d8ff',
      green: '#b2f2bb',
      orange: '#ffd8a8',
      pink: '#fcc2d7',
      gray: '#e9ecef',
      white: '#ffffff',
      black: '#343a40',
    },
    note: 'yellow',
    font: 5,
    heading: 7,
    rough: 1,
    width: 2,
    fill: 'solid',
    sheet: [
      'Black marker on warm white paper, one accent (red) for the tension or the takeaway, one highlighter (yellow fill) for the one thing to remember: never more colours than that.',
      'The title is big display lettering (size l) in a banner or ribbon drawn in strokes; each section gets a hand-lettered header with a small icon.',
      'Draw the idea before you write it: stick figures, objects, a speech bubble, a path, a metaphor; captions are short (about twelve words), speech shorter.',
      'Hold ideas in containers (clouds, bubbles, boxes with a thick edge) and join them with curving connectors; four to six beats flow left to right or around a centre, with generous gaps.',
      'Bullets are dots, stars and numbers drawn by hand; 2 for ordinary lines, bold strokes for emphasis; mostly unfilled, a little hatching for shadow.',
    ],
    test: 'Explain why adding engineers can slow a late project, in five illustrated scenes for a nontechnical audience.',
  },
  mindmap: {
    name: 'mindmap',
    title: 'Mind map',
    from: "Tony Buzan's mind maps: one centre, coloured branches radiating, a keyword on each",
    paper: '#ffffff',
    ink: '#212529',
    soft: '#adb5bd',
    outline: '#212529',
    inks: {
      black: '#212529',
      blue: '#1864ab',
      green: '#2b8a3e',
      orange: '#d9480f',
      red: '#c92a2a',
      pink: '#a61e4d',
      yellow: '#b08900',
      gray: '#adb5bd',
      white: '#ffffff',
    },
    paints: {
      blue: '#d0ebff',
      green: '#d3f9d8',
      orange: '#ffe8cc',
      red: '#ffe3e3',
      pink: '#ffdeeb',
      yellow: '#fff3bf',
      gray: '#f1f3f5',
      white: '#ffffff',
      black: '#343a40',
    },
    note: 'yellow',
    font: 5,
    heading: 5,
    rough: 0,
    width: 2,
    fill: 'solid',
    sheet: [
      'One subject at the centre: a size l title with a small simple image, and nothing else there; five to seven branch families radiate from it with clear gaps between them.',
      'Branches are organic curves drawn as sketch strokes, never boxes and never arrowheads: bold from the centre, medium for the second level, thin for the third; two or three levels at most.',
      'Each family has one colour, the same on its curves and on every label along them; the colours are blue, green, orange, red, pink and yellow.',
      'Labels sit just above their branch, a keyword or a short phrase, size m on the first level then s; one word a branch where you can.',
      'Arrowheads only for a genuine cross-link between families, labelled; small icons only where they add meaning; no sticky notes, no frames.',
    ],
    test: 'Brainstorm ways to improve a public library, with six main branches and two levels of ideas.',
  },
  sprint: {
    name: 'sprint',
    title: 'Sprint wall',
    from: 'the design-sprint wall: IDEO workshops, Google Ventures sprints, sticky-note boards in Miro and FigJam',
    paper: '#f8f9fa',
    ink: '#212529',
    soft: '#adb5bd',
    outline: '#ced4da',
    inks: {
      black: '#212529',
      gray: '#868e96',
      blue: '#1971c2',
      red: '#c92a2a',
      green: '#2b8a3e',
      orange: '#e8590c',
      yellow: '#b08900',
      pink: '#c2255c',
      white: '#ffffff',
    },
    paints: {
      yellow: '#fff3bf',
      pink: '#ffdeeb',
      blue: '#d0ebff',
      green: '#d3f9d8',
      red: '#ffe3e3',
      orange: '#ffe8cc',
      gray: '#e9ecef',
      white: '#ffffff',
      black: '#495057',
    },
    note: 'yellow',
    font: 6,
    heading: 6,
    rough: 0,
    width: 1,
    fill: 'solid',
    sheet: [
      'Sticky notes are the unit: one idea a note, twelve words at most, in a clean sans face; yellow by default, another colour only for a category you name once in a small key.',
      'Three to six titled frames as columns, lanes or clusters (How might we, Now, Next, Later, Decide); equal-sized notes aligned inside them, a note-width of room between groups.',
      'Clean geometry, no wobble, thin grey lines; headings small and quiet (size m), the notes carry the colour; no illustrations beyond a quick wireframe in a white box.',
      'Cluster by moving notes, not by drawing arrows; an arrow only for a real dependency, labelled.',
      'Vote with small dots drawn on a note, mark the pick with a frame or a star, add owners and status only when given or marked as proposed.',
    ],
    test: 'Plan a two-week onboarding improvement sprint with eight tasks in Now, Next and Later and two dependencies; leave owners unassigned.',
  },
  blueprint: {
    name: 'blueprint',
    title: 'Blueprint',
    from: 'engineering diagrams: the C4 model and UML, architecture whiteboards at tech talks',
    paper: '#f4f7fb',
    ink: '#1f2937',
    soft: '#64748b',
    outline: '#2563eb',
    inks: {
      black: '#1f2937',
      gray: '#64748b',
      blue: '#2563eb',
      red: '#b91c1c',
      green: '#15803d',
      orange: '#c2410c',
      yellow: '#a16207',
      pink: '#9d174d',
      white: '#ffffff',
    },
    paints: {
      blue: '#dbeafe',
      gray: '#f1f5f9',
      white: '#ffffff',
      green: '#dcfce7',
      yellow: '#fef9c3',
      red: '#fee2e2',
      orange: '#ffedd5',
      pink: '#fce7f3',
      black: '#1f2937',
    },
    note: 'white',
    font: 6,
    heading: 6,
    rough: 0,
    width: 2,
    fill: 'solid',
    edge: true,
    sheet: [
      'A clean engineering diagram: the title names the subject, its level (context, container, component) and its scope; a legend when colour means anything.',
      'Aligned rectangles, the same size for comparable parts; each names the part, its type and its responsibility in a short line (technology where it matters), size m names and size s detail.',
      'In-scope parts are filled blue with a blue edge, external systems grey, data stores drawn as cylinders in strokes, people as small figures or labelled ellipses; a titled frame is a boundary.',
      'The main interaction runs left to right, secondary dependencies below; every arrow is labelled with its action and protocol, and runs straight.',
      'Six to twelve parts a view; deeper detail goes to another board or a page card; no sticky notes, no freehand, no handwriting.',
    ],
    test: 'Draw a container-level architecture for a photo-sharing app with a browser, API, worker, queue, database and object storage; label protocols and responsibilities.',
  },
};

/** The one persona line a chosen look becomes, within the 140 characters a trait may hold. */
export const lookInstruction = (name: LookName) =>
  `Prefer ${LOOKS[name].title} drawings. Pass look ${name} for guidance only; adapt to the task and preserve existing artwork.`;
/** The sheet an agent is given with a board that wears a look. */
export const lookSheet = (look: Look) =>
  `${look.title} (${look.from}). Guidance only: adapt to the task and the board's existing paper, preserving artwork. ${look.sheet.join(' ')}`;
/** Whether a paper is dark, so labels on light fills take a dark ink. */
export const isDark = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
};

/** Excalidraw's dark theme inverts both paper and ink. Dark-paper artwork already has
 * bright ink: keep that pair in its authored colours instead of inverting it onto white.
 * This is a canvas rendering choice, independent of the surrounding app's appearance.
 */
export function boardAppearance(paper = '#ffffff', appearance: 'light' | 'dark') {
  const dark = appearance === 'dark' && !isDark(paper);
  return {
    theme: dark ? ('dark' as const) : ('light' as const),
    viewBackgroundColor: dark ? '#ffffff' : paper,
  };
}
