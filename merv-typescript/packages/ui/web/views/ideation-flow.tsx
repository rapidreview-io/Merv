import { useBoardView } from '../board-app/board-view';
/**
 * The demo (founder, 2026-11-06: kept for showing and for inspiration): a scripted story, spoken in
 * the Mac's own voices, of thinking with Merv on the board and handing it to Codex. It plays only on a
 * board opened with ?demo inside Merv.app, and nothing in it reaches Merv or an agent: the panel's
 * mock session (desk-ui demo.tsx) plays Codex's side, and the two speak only through mervApp.demo.
 * Closed (Esc, ×) or done, the board is a board again.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  getCommonBounds,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { useAgent } from './pi';
import { ProviderMark } from '../panel/marks';
import { AskCard } from './board-handoff';
import './ideation-flow.css';

type Pt = { x: number; y: number };
type Rect = { x1: number; y1: number; x2: number; y2: number };
type Actor = 'merv' | 'codex' | 'you';
type Speaker = 'Merv' | 'You';
interface Question {
  id: string;
  text: string;
  near: string[];
  kind: 'choice' | 'text';
  options?: string[];
}
type Demo = { send(message: unknown): void; on(heard: (message: unknown) => void): () => void };

const app = () => (window as unknown as { mervApp?: { demo?: Demo } }).mervApp;
const report = (error: unknown) => console.error('[demo]', error);
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) =>
  new Promise((done) => setTimeout(done, calm() ? Math.min(ms, 120) : ms));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const boundsOf = (els: readonly ExcalidrawElement[]): Rect => {
  const [x1, y1, x2, y2] = getCommonBounds(els);
  return { x1, y1, x2, y2 };
};
const NAMES: Record<Actor, string> = { merv: 'Merv', codex: 'Codex', you: 'You' };

/** The write-up the person drops on the board. */
const PAPER = {
  title: 'Landing pages that convert',
  body: 'Patterns from Linear, Vercel and Stripe.\n\nLead with one promise and a real\nproduct visual.\n\nShow proof early: logos and numbers\nright under the fold.\n\nGroup features in a bento grid,\nnot a list.\n\nOne primary call to action, repeated.\n\nShip a fast page first; motion second.',
};
/** What Merv pulls out of it, as notes beside it. */
const STICKIES = [
  { x: 380, y: 80, text: 'Hero: one promise\n+ a real product visual' },
  { x: 580, y: 80, text: 'Proof strip right\nunder the fold' },
  { x: 380, y: 190, text: 'Bento grid\nof features' },
  { x: 580, y: 190, text: 'One primary CTA,\nrepeated' },
  { x: 380, y: 300, text: 'Fast first,\nmotion second' },
];
const STICKY = { width: 180, height: 90 };
/** What the person sketches while they talk the layout through, right of the notes. */
const SKETCH = [
  { x: 820, y: 80, width: 380, height: 56 },
  { x: 820, y: 148, width: 184, height: 70 },
  { x: 1016, y: 148, width: 184, height: 70 },
  { x: 820, y: 230, width: 380, height: 30 },
];
const SAID = 'Perfect. Execute this: build it in landing-site.';
/** What Merv hands Codex: the line on its chip, and the task it wrote from the talk. */
const CONTEXT = 'The bento grid and the product-visual hero are what they love';
const BRIEF = `Build the landing page in landing-site from what we settled on the board:\n${STICKIES.map((s) => `- ${s.text.replace(/\n/g, ' ')}`).join('\n')}\nThey love the bento grid and the product-visual hero. Ask before you start if anything is open.`;
/** The voices the demo speaks in: the Mac's own, nothing leaves it. */
const VOICES: Record<Speaker, string[]> = {
  Merv: ['Samantha', 'Ava', 'Karen', 'Moira', 'Victoria'],
  You: ['Daniel', 'Alex', 'Fred', 'Tom', 'Aaron'],
};
const voiceFor = (who: Speaker) => {
  const all = typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
  return (
    VOICES[who].map((name) => all.find((v) => v.name.startsWith(name))).find(Boolean) ??
    all.find((v) => v.lang.startsWith('en')) ??
    null
  );
};

async function snapshot(
  api: ExcalidrawImperativeAPI,
  els: readonly ExcalidrawElement[],
  most = 720,
) {
  const state = api.getAppState();
  const blob = await exportToBlob({
    elements: els,
    appState: {
      exportBackground: true,
      viewBackgroundColor: state.viewBackgroundColor,
      exportWithDarkMode: state.theme === 'dark',
    },
    files: api.getFiles(),
    mimeType: 'image/png',
    maxWidthOrHeight: most,
    exportPadding: 16,
  });
  return new Promise<string>((done) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export function IdeationFlow({ api, board }: { api: ExcalidrawImperativeAPI; board: string }) {
  const voice = useAgent()?.voice;
  const [, setSearch] = useSearchParams();
  const [cursors, setCursors] = useState<Partial<Record<Actor, Pt>>>({});
  const [bubble, setBubble] = useState<{ actor: Actor; text: string } | null>(null);
  const [asking, setAsking] = useState<Question | null>(null);
  const [talking, setTalking] = useState(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [flash, setFlash] = useState<Rect | null>(null);
  const [ghost, setGhost] = useState<{
    url: string;
    x: number;
    y: number;
    w: number;
    h: number;
    scale: number;
    opacity: number;
  } | null>(null);
  const [caption, setCaption] = useState<{ who: Speaker; text: string } | null>(null);
  useBoardView(api);
  const where = useRef<Partial<Record<Actor, Pt>>>({});
  const run = useRef(0);
  const root = useRef<Rect | null>(null);
  const answering = useRef<((value: string) => void) | null>(null);
  const sketched = useRef<ExcalidrawElement[]>([]);

  const client = (p: Pt) =>
    sceneCoordsToViewportCoords({ sceneX: p.x, sceneY: p.y }, api.getAppState());
  const scene = (x: number, y: number) => {
    const p = viewportCoordsToSceneCoords({ clientX: x, clientY: y }, api.getAppState());
    return { x: p.x, y: p.y };
  };
  /** Where agents come from and go: the window's right edge, the panel's side. */
  const edge = () => {
    const { offsetLeft, offsetTop, width, height } = api.getAppState();
    return scene(offsetLeft + width + 24, offsetTop + height * 0.42);
  };
  const show = (actor: Actor, p?: Pt) => {
    where.current = { ...where.current, [actor]: p };
    setCursors(where.current);
  };
  const glide = (actor: Actor, to: Pt, ms = 700) =>
    new Promise<void>((done) => {
      const from = where.current[actor] ?? edge();
      const id = run.current;
      const start = performance.now();
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const lift = Math.min(70, length * 0.12);
      const step = (now: number) => {
        if (id !== run.current) return done();
        const t = Math.min(1, (now - start) / (calm() ? 1 : ms));
        const k = ease(t);
        const arc = Math.sin(Math.PI * t) * lift;
        show(actor, {
          x: from.x + dx * k + (-dy / length) * arc,
          y: from.y + dy * k + (dx / length) * arc,
        });
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
  const leave = async (actor: Actor) => {
    const id = run.current;
    setBubble((was) => (was?.actor === actor ? null : was));
    await glide(actor, edge(), 600);
    if (id !== run.current) return;
    show(actor);
  };
  /** Codex draws a marquee from one corner to the other, its cursor at the growing corner. */
  const sweep = (r: Rect, ms = 850) =>
    new Promise<void>((done) => {
      const id = run.current;
      const start = performance.now();
      const step = (now: number) => {
        if (id !== run.current) return done();
        const t = ease(Math.min(1, (now - start) / (calm() ? 1 : ms)));
        const corner = { x: r.x1 + (r.x2 - r.x1) * t, y: r.y1 + (r.y2 - r.y1) * t };
        setMarquee({ x1: r.x1, y1: r.y1, x2: corner.x, y2: corner.y });
        show('codex', corner);
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
  /** The snapshot shrinks and flies off right, towards the panel, with Codex holding it. */
  const flyOff = (r: Rect, url: string) =>
    new Promise<void>((done) => {
      const a = client({ x: r.x1, y: r.y1 });
      const b = client({ x: r.x2, y: r.y2 });
      const [w, h] = [b.x - a.x, b.y - a.y];
      const { offsetLeft, width } = api.getAppState();
      const id = run.current;
      const start = performance.now();
      const step = (now: number) => {
        if (id !== run.current) return done();
        const t = Math.min(1, (now - start) / (calm() ? 1 : 950));
        const k = t * t * (3 - 2 * t);
        const x = a.x + (offsetLeft + width - a.x) * k;
        const y = a.y + h * 0.15 * k;
        const scale = 1 - 0.75 * k;
        setGhost({ url, x, y, w, h, scale, opacity: 0.9 - 0.8 * Math.max(0, (t - 0.55) / 0.45) });
        show('codex', scene(x + w * scale, y + h * scale));
        if (t < 1) requestAnimationFrame(step);
        else {
          setGhost(null);
          done();
        }
      };
      requestAnimationFrame(step);
    });

  /** A line said aloud in the Mac's own voice, captioned; it ends when the voice does. */
  const say = (id: number, speaker: Speaker, text: string) =>
    new Promise<void>((done) => {
      if (id !== run.current) return done();
      setCaption({ who: speaker, text });
      const least = Math.max(1400, text.length * 58);
      const began = Date.now();
      let over = false;
      const end = () => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        // A voice that ended at once was not heard: the caption stays for as long as reading takes.
        setTimeout(() => done(), Math.max(0, least * 0.6 - (Date.now() - began)));
      };
      const timer = setTimeout(end, least * 2);
      if (typeof speechSynthesis === 'undefined') return void setTimeout(end, least);
      const line = new SpeechSynthesisUtterance(text);
      line.voice = voiceFor(speaker);
      line.rate = speaker === 'Merv' ? 1.04 : 1;
      line.onend = end;
      line.onerror = end;
      speechSynthesis.speak(line);
    });
  const make = (skeletons: Parameters<typeof convertToExcalidrawElements>[0]) => {
    const made = convertToExcalidrawElements(skeletons);
    api.updateScene({
      elements: [...api.getSceneElements(), ...made],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return made;
  };
  /** Over: the voices stop, the panel's half is told unless it said so, and ?demo goes. */
  const stop = (tell = true) => {
    run.current++;
    answering.current?.('');
    answering.current = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    if (tell) app()?.demo?.send({ type: 'reset' });
    setSearch(
      (now) => {
        const next = new URLSearchParams(now);
        next.delete('demo');
        return next;
      },
      { replace: true },
    );
  };

  /** The person's cursor presses what they would press; a button not there is pressed anyway. */
  const press = async (button: HTMLElement | undefined, otherwise: () => void) => {
    const id = run.current;
    const mine = answering.current;
    if (button) {
      const r = button.getBoundingClientRect();
      await glide('you', scene(r.x + r.width / 2, r.y + r.height / 2), 650);
      if (id !== run.current) return;
      await wait(260);
      if (id !== run.current) return;
    }
    if (answering.current !== mine) return;
    if (button) button.click();
    else otherwise();
  };
  const cardButton = (match: (b: HTMLButtonElement) => boolean) =>
    [...document.querySelectorAll<HTMLButtonElement>('.ideation-ask button')].find(match);
  const autoAnswer = async (question: Question) => {
    const id = run.current;
    await wait(700);
    if (id !== run.current) return;
    if (question.kind === 'choice') {
      const pick = question.id === 'hero' ? 'Product visual' : 'Soft blue';
      const line = say(
        id,
        'You',
        question.id === 'hero' ? 'The product visual.' : 'That soft blue.',
      );
      await press(
        cardButton((b) => b.textContent?.trim() === pick),
        () => answering.current?.(pick),
      );
      if (id !== run.current) return;
      return void (await line);
    }
    await press(
      cardButton((b) => /talk|voice|mic|speak/i.test(`${b.getAttribute('aria-label')} ${b.title}`)),
      () => setTalking(true),
    );
    if (id !== run.current) return;
    setTalking(true);
    const words =
      'Hero full width on top, the bento grid right under it, then one call to action strip. Like this.';
    const line = say(id, 'You', words);
    for (const box of SKETCH) {
      await glide('you', { x: box.x, y: box.y }, 520);
      if (id !== run.current) return;
      await glide('you', { x: box.x + box.width, y: box.y + box.height }, 620);
      if (id !== run.current) return;
      sketched.current.push(
        ...make([
          {
            type: 'rectangle',
            ...box,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            strokeWidth: 2,
            roughness: 2,
          },
        ]),
      );
    }
    await line;
    if (id !== run.current) return;
    await say(id, 'You', "That's it.");
    if (id !== run.current) return;
    answering.current?.(words);
  };

  /** Where a question belongs: beside the note it is about, else beside what was handed over. */
  const anchor = (question: Question, index: number, of: number): Pt => {
    const all = api.getSceneElements().filter((el) => !el.isDeleted);
    const text = all.find(
      (el) =>
        el.type === 'text' &&
        question.near.some((w) => ((el as { text?: string }).text ?? '').toLowerCase().includes(w)),
    );
    const container = (text as { containerId?: string | null } | undefined)?.containerId;
    const host = container ? (all.find((el) => el.id === container) ?? text) : text;
    if (host) return { x: host.x + host.width + 12, y: host.y + Math.min(host.height / 2, 24) };
    const r = root.current ?? boundsOf(all);
    return { x: r.x1 + ((r.x2 - r.x1) * (index + 1)) / (of + 1), y: r.y1 + (r.y2 - r.y1) * 0.35 };
  };

  /** "Execute this": Merv meets Codex at the work, hands it what was discussed, and Codex snapshots it. */
  const handoff = async (els: readonly ExcalidrawElement[]) => {
    const id = run.current;
    const r = boundsOf(els);
    root.current = r;
    const pad = 18 / api.getAppState().zoom.value;
    const box = { x1: r.x1 - pad, y1: r.y1 - pad, x2: r.x2 + pad, y2: r.y2 + pad };
    const shot = snapshot(api, els);
    show('merv', edge());
    await glide('merv', { x: box.x2, y: box.y1 }, 700);
    if (id !== run.current) return;
    setBubble({ actor: 'merv', text: CONTEXT });
    show('codex', edge());
    await glide(
      'codex',
      {
        x: box.x2 + 40 / api.getAppState().zoom.value,
        y: box.y1 + 30 / api.getAppState().zoom.value,
      },
      900,
    );
    if (id !== run.current) return;
    await wait(900);
    if (id !== run.current) return;
    setBubble({ actor: 'codex', text: CONTEXT });
    void leave('merv');
    await wait(700);
    if (id !== run.current) return;
    setBubble(null);
    await glide('codex', { x: box.x1, y: box.y1 }, 650);
    if (id !== run.current) return;
    await sweep(box);
    if (id !== run.current) return;
    setMarquee(null);
    setFlash(box);
    await wait(150);
    if (id !== run.current) return;
    setFlash(null);
    const image = await shot;
    if (id !== run.current) return;
    await flyOff(box, image);
    if (id !== run.current) return;
    show('codex');
    app()?.demo?.send({
      type: 'captured',
      board,
      folder: 'landing-site',
      image,
      context: CONTEXT,
      brief: BRIEF,
      said: SAID,
    });
  };

  /** Codex's questions, one at a time beside what each is about; the answers go back to the panel. */
  const ask = async (questions: Question[]) => {
    const id = run.current;
    const answers: string[] = [];
    sketched.current = [];
    show('codex', edge());
    for (const [index, question] of questions.entries()) {
      await glide('codex', anchor(question, index, questions.length), index ? 650 : 800);
      if (id !== run.current) return;
      setBubble({ actor: 'codex', text: 'Thinking…' });
      await wait(900);
      if (id !== run.current) return;
      setBubble(null);
      const value = new Promise<string>((done) => (answering.current = done));
      setAsking(question);
      autoAnswer(question).catch(report);
      answers.push(await value);
      if (id !== run.current) return;
      answering.current = null;
      setAsking(null);
      setTalking(false);
      setBubble({ actor: 'codex', text: 'Got it' });
      app()?.demo?.send({ type: 'answered', count: index + 1 });
      await wait(550);
      if (id !== run.current) return;
    }
    const image = sketched.current.length ? await snapshot(api, sketched.current, 560) : undefined;
    if (id !== run.current) return;
    await leave('codex');
    if (id !== run.current) return;
    app()?.demo?.send({ type: 'answers', answers, image });
  };

  /** The result comes back as a card in the bay below the work: the outcome, not the process. */
  const result = async (title: string, lines: string[]) => {
    const id = run.current;
    const r = root.current ?? boundsOf(api.getSceneElements().filter((el) => !el.isDeleted));
    const spot = { x: r.x1, y: r.y2 + 24 };
    show('codex', edge());
    await glide('codex', { x: spot.x + 340, y: spot.y + 40 }, 900);
    if (id !== run.current) return;
    make([
      {
        type: 'rectangle',
        ...spot,
        width: 360,
        height: 64 + lines.length * 24,
        strokeColor: '#2f9e44',
        backgroundColor: '#ebfbee',
        fillStyle: 'solid',
        strokeWidth: 1,
        roundness: { type: 3 },
        label: {
          text: `✓ ${title}\n${lines.join('\n')}`,
          fontSize: 16,
          textAlign: 'left',
          verticalAlign: 'top',
        },
      },
    ]);
    setBubble({ actor: 'codex', text: title });
    await wait(1800);
    if (id !== run.current) return;
    await leave('codex');
    if (id !== run.current) return;
    await say(
      id,
      'Merv',
      'Codex is done. The landing page is built, and the result is on the board.',
    );
    if (id !== run.current) return;
    await wait(1200);
    if (id !== run.current) return;
    stop();
  };

  const play = async () => {
    const id = run.current;
    // Merv's own voice is closed while the demo speaks, so it neither hears nor answers it.
    if (voice && voice.state !== 'off') voice.stop();
    app()?.demo?.send({ type: 'reset' });
    api.updateScene({
      appState: {
        scrollX: 40,
        scrollY: 20,
        zoom: { value: 0.75 } as never,
        selectedElementIds: {},
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const { offsetLeft, offsetTop, width, height } = api.getAppState();
    show('you', scene(offsetLeft + width * 0.4, offsetTop + height - 30));
    // 1. The person brings a write-up to the board.
    let line = say(
      id,
      'You',
      "Merv, here's a write-up on how great landing pages are put together. Pull out the ideas that matter.",
    );
    await glide('you', { x: 190, y: 240 }, 1100);
    if (id !== run.current) return;
    const made = make([
      {
        type: 'rectangle',
        x: 20,
        y: 70,
        width: 320,
        height: 380,
        strokeColor: '#495057',
        backgroundColor: '#f1f3f5',
        fillStyle: 'solid',
        strokeWidth: 1,
        roundness: { type: 3 },
      },
      { type: 'text', x: 40, y: 88, text: PAPER.title, fontSize: 22 },
      { type: 'text', x: 40, y: 130, text: PAPER.body, fontSize: 14 },
    ]);
    await line;
    if (id !== run.current) return;
    // 2. Merv pulls the ideas out, one note at a time.
    show('merv', edge());
    line = say(id, 'Merv', 'Here are the five ideas that matter.');
    for (const sticky of STICKIES) {
      await glide(
        'merv',
        { x: sticky.x + STICKY.width - 14, y: sticky.y + STICKY.height - 12 },
        620,
      );
      if (id !== run.current) return;
      made.push(
        ...make([
          {
            type: 'rectangle',
            x: sticky.x,
            y: sticky.y,
            ...STICKY,
            strokeColor: '#f08c00',
            backgroundColor: '#ffec99',
            fillStyle: 'solid',
            strokeWidth: 1,
            roundness: { type: 3 },
            label: { text: sticky.text, fontSize: 16 },
          },
        ]),
      );
      await wait(220);
      if (id !== run.current) return;
    }
    await line;
    if (id !== run.current) return;
    await leave('merv');
    if (id !== run.current) return;
    // 3. The person circles what they like and asks.
    line = say(
      id,
      'You',
      'I love the bento grid and the product-visual hero. Why does the bento work?',
    );
    const bento = STICKIES[2]!;
    await glide('you', { x: bento.x - 14, y: bento.y - 12 }, 700);
    if (id !== run.current) return;
    await glide('you', { x: bento.x + STICKY.width + 14, y: bento.y + STICKY.height + 12 }, 800);
    if (id !== run.current) return;
    made.push(
      ...make([
        {
          type: 'ellipse',
          x: bento.x - 18,
          y: bento.y - 16,
          width: STICKY.width + 36,
          height: STICKY.height + 32,
          strokeColor: '#e03131',
          backgroundColor: 'transparent',
          strokeWidth: 2,
        },
      ]),
    );
    await line;
    if (id !== run.current) return;
    // 4. Merv explains, at the note.
    show('merv', edge());
    await glide('merv', { x: bento.x + STICKY.width + 24, y: bento.y + 30 }, 700);
    if (id !== run.current) return;
    await say(
      id,
      'Merv',
      'Because one screen can show many features at different weights, so people scan instead of read. Pair it with the product visual and the page explains itself.',
    );
    if (id !== run.current) return;
    await leave('merv');
    if (id !== run.current) return;
    // 5. Ideation is done: the person hands it over, and Merv writes the task.
    await say(id, 'You', SAID);
    if (id !== run.current) return;
    await say(id, 'Merv', 'Handing this to Codex.');
    if (id !== run.current) return;
    setCaption(null);
    await handoff(made);
    if (id !== run.current) return;
  };

  // The panel's mock Codex speaks to the canvas; the story starts once, as the board opens.
  useEffect(() => {
    const demo = app()?.demo;
    if (!demo) return;
    const off = demo.on((raw) => {
      const message = raw as {
        type?: string;
        questions?: Question[];
        title?: string;
        lines?: string[];
      };
      if (message.type === 'ask' && message.questions) ask(message.questions).catch(report);
      if (message.type === 'result')
        result(message.title ?? 'Done', message.lines ?? []).catch(report);
      if (message.type === 'reset') stop(false);
    });
    const key = (event: KeyboardEvent) => event.key === 'Escape' && stop();
    addEventListener('keydown', key);
    play().catch(report);
    return () => {
      off();
      removeEventListener('keydown', key);
      run.current++;
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
      // Leaving the board ends the panel's mock session too, so it never covers real ones.
      demo.send({ type: 'reset' });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  if (!app()?.demo) return null;
  const rect = (r: Rect) => {
    const a = client({ x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2) });
    const b = client({ x: Math.max(r.x1, r.x2), y: Math.max(r.y1, r.y2) });
    return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
  };
  return (
    <div className="ideation-layer">
      {marquee && <div className="ideation-marquee" style={rect(marquee)} />}
      {flash && <div className="ideation-flash" style={rect(flash)} />}
      {ghost && (
        <img
          className="ideation-ghost"
          src={ghost.url}
          alt=""
          style={{
            left: ghost.x,
            top: ghost.y,
            width: ghost.w,
            height: ghost.h,
            opacity: ghost.opacity,
            transform: `scale(${ghost.scale})`,
          }}
        />
      )}
      {(['merv', 'codex', 'you'] as const).map((actor) => {
        const p = cursors[actor] && client(cursors[actor]!);
        return (
          p && (
            <div
              key={actor}
              className={`ideation-cursor is-${actor}`}
              style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
            >
              <svg
                className="ideation-arrow"
                width="18"
                height="20"
                viewBox="0 0 18 20"
                aria-hidden="true"
              >
                <path
                  d="M1.5 1.5 16 9.2l-6.4 1.6-3.1 6.4z"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="ideation-name">
                {actor === 'codex' ? (
                  <ProviderMark provider="codex" size={12} />
                ) : (
                  actor === 'merv' && <span className="ideation-orb" />
                )}
                {NAMES[actor]}
                {actor === 'you' && talking && <span className="ideation-listening" />}
              </span>
              {bubble?.actor === actor && <span className="ideation-bubble">{bubble.text}</span>}
              {actor === 'codex' && asking && (
                <div className="ideation-ask" onPointerDown={(event) => event.stopPropagation()}>
                  <AskCard
                    provider="codex"
                    question={asking.text}
                    options={asking.options ?? []}
                    kind={asking.kind}
                    onAnswer={(value: unknown) => answering.current?.(String(value))}
                    onTalk={() => setTalking(true)}
                  />
                </div>
              )}
            </div>
          )
        );
      })}
      {caption && (
        <p className={`ideation-caption is-${caption.who.toLowerCase()}`} role="status">
          <span className="ideation-caption-who">{caption.who}</span>
          {caption.text}
          <button
            type="button"
            className="ideation-close"
            aria-label="Close the demo"
            onClick={() => stop()}
          >
            ×
          </button>
        </p>
      )}
    </div>
  );
}
