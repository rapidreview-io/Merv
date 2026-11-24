import { publicError } from '../errors';
import { agentName, sessionTitle, delivery } from '../board-app/sessions';
export { agentName } from '../board-app/sessions';
/**
 * The voice connected to one of the person's agents on their Mac (docs/voice-routing.md, phase
 * one): what is said goes to that session as the person's own message, marked as voice, and what
 * the voice says back is that turn's own answer, read live from the Mac and kept nowhere here.
 */
import type { VoiceRead } from '@merv/protocol/link';
import { accountRequest } from '../api';

/** The one session a voice is connected to, pinned by its Mac and thread. A new one has no thread
 *  until the first thing said to it starts it, in `project`. */
export interface VoiceTarget {
  device: string;
  thread: string;
  provider: 'claude' | 'codex';
  title: string;
  /** Its folder's name. */
  label: string;
  project?: string;
  command?: string;
  /** When it last did anything. */
  at?: string;
  state?: string;
  capabilities?: { read: boolean; message: boolean; stop: boolean; answer: boolean };
  unavailable?: string;
  /** It is its project's main thread: `title` is then the project's name. */
  main?: boolean;
}
type Mac = {
  id: string;
  label?: string;
  connected: boolean;
  providers?: VoiceTarget['provider'][];
  home?: { project: string; label: string };
};
type CatalogSession = {
  session: string;
  thread?: string;
  device: string;
  provider: VoiceTarget['provider'];
  title: string;
  label: string;
  folder: string;
  lastActivity: string;
  state: string;
  capabilities: NonNullable<VoiceTarget['capabilities']>;
  unavailable?: string;
  main?: { name: string };
};
type Catalog = {
  devices: Mac[];
  sessions: CatalogSession[];
  nextCursor?: string;
  clipped: boolean;
};

/** Who the voice is, in a few words: "Codex · fixing auth", or for a project's main thread "merv-desktop · Claude Code". */
export const targetName = (target: VoiceTarget) =>
  target.main
    ? `${target.title} · ${agentName(target.provider)}`
    : `${agentName(target.provider)} · ${target.title}`;
/** What the chip beside the orb says: the project's name for a main thread. */
export const chipName = (target: VoiceTarget) => (target.main ? target.title : targetName(target));

/** Each project with a main thread, on every Mac the person has linked, the most recently active
 *  first. A project whose Mac is offline is listed with that said, and cannot take words. */
export async function voiceProjects(): Promise<VoiceTarget[]> {
  const params = new URLSearchParams({ main: 'true', includeArchived: 'false', limit: '100' });
  const { devices, sessions } = await accountRequest<Catalog>(`/desk/sessions?${params}`, {
    scoped: true,
  });
  const macs = new Map(devices.map((mac) => [mac.id, mac]));
  const several = new Set(sessions.map((session) => session.device)).size > 1;
  return sessions
    .filter((session) => session.main)
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .map((session) => {
      const mac = macs.get(session.device);
      const offline = !mac?.connected;
      return {
        device: session.device,
        thread: session.thread || session.session,
        provider: session.provider,
        title: session.main!.name,
        label: several ? (mac?.label ?? '').replace(/\.local$/, '') : '',
        at: session.lastActivity,
        state: session.state,
        main: true,
        capabilities: offline
          ? { ...session.capabilities, message: false, stop: false }
          : session.capabilities,
        ...(offline
          ? { unavailable: 'Mac is offline' }
          : session.unavailable && { unavailable: session.unavailable }),
      };
    });
}

const post = <T>(path: string, body: unknown) =>
  accountRequest<T>(path, { method: 'POST', scoped: true, body });

/** How many of the person's sessions the picker shows, besides a new one. */
export const RECENT = 6;
/** Sessions on a connected Mac, working ones first, then the latest, so the voice goes back to a
 *  chat instead of starting one; then a new Claude Code and Codex in their default folder. The Mac
 *  still decides when asked. The picker and provider-only requests use `recent` idle sessions; a
 *  description or typed search can read up to five pages. */
export async function voiceTargets(
  query = '',
  options: { recent?: number; provider?: VoiceTarget['provider'] } = {},
) {
  const recent = query.trim() ? undefined : options.recent;
  const params = new URLSearchParams({ query, includeArchived: 'false' });
  if (options.provider) params.set('provider', options.provider);
  if (recent === undefined) params.set('limit', '100');
  const first = await accountRequest<Catalog>(`/desk/sessions?${params}`, { scoped: true });
  const macs = first.devices.filter((mac) => mac.connected);
  const connected = new Set(macs.map((mac) => mac.id));
  const sessions = new Map(
    first.sessions.map((session) => [`${session.device}:${session.session}`, session]),
  );
  // desk.list orders all four active states before idle history. Reaching enough connected idle
  // rows proves we've passed every running/waiting session, even across pages or offline Macs.
  const enough = () =>
    recent !== undefined &&
    [...sessions.values()].filter(
      (session) =>
        connected.has(session.device) &&
        !['running', 'waiting', 'starting', 'running elsewhere'].includes(session.state),
    ).length >= Math.max(1, recent);
  let cursor = first.nextCursor;
  const seen = new Set<string>();
  // The first page is already read; bound the lookup even while the catalog keeps changing.
  while (cursor && seen.size < 4 && !seen.has(cursor) && !enough()) {
    seen.add(cursor);
    params.set('cursor', cursor);
    const page = await accountRequest<Catalog>(`/desk/sessions?${params}`, { scoped: true });
    for (const session of page.sessions)
      sessions.set(`${session.device}:${session.session}`, session);
    cursor = page.nextCursor;
  }
  const busy = (session: CatalogSession) =>
    session.state === 'running' || session.state === 'waiting';
  let shown = 0;
  const running = [...sessions.values()]
    .filter((session) => connected.has(session.device))
    .sort(
      (a, b) => Number(busy(b)) - Number(busy(a)) || b.lastActivity.localeCompare(a.lastActivity),
    )
    .filter((session) => recent === undefined || busy(session) || shown++ < recent)
    .map((session) => ({
      device: session.device,
      thread: session.thread || session.session,
      provider: session.provider,
      title: sessionTitle(session as unknown as Parameters<typeof sessionTitle>[0]),
      label: session.label || session.folder,
      at: session.lastActivity,
      state: session.state,
      capabilities: session.capabilities,
      unavailable: session.unavailable,
    }));
  // A new one of each agent on every connected Mac that has it, in that Mac's default folder.
  const fresh = macs.flatMap((mac) => {
    const home = mac.home;
    return home
      ? (mac.providers ?? ['claude', 'codex'])
          .filter(
            (provider) =>
              (!options.provider || provider === options.provider) &&
              (!query.trim() ||
                `${agentName(provider)} ${home.label}`
                  .toLowerCase()
                  .includes(query.trim().toLowerCase())),
          )
          .map((provider) => ({
            device: mac.id,
            thread: '',
            provider,
            title: home.label,
            label: home.label,
            project: home.project,
          }))
      : [];
  });
  return { targets: [...running, ...fresh], connected: macs.length > 0 };
}

/** A spoken request names a provider, a session description, or both. */
const TO =
  /^\s*(?:(?:okay|ok|hey|please|now)[\s.!,]+)*(?:connect|switch|transfer|take|put|hand)\s+(?:me\s+)?(?:over\s+)?to\s+(.+?)\s*[.!?]*$/i;
const EXCLUDED_PROVIDER =
  /\b(?:not|except|without|instead of|rather than|other than|anything but)\s+(?:(?:the|a|on|in|for|with|using)\s+)*(?:claude(?: code)?|codex)\b/gi;
const FILLERS = new Set([
  'the',
  'one',
  'my',
  'me',
  'to',
  'on',
  'in',
  'of',
  'for',
  'and',
  'or',
  'session',
  'please',
  'that',
  'working',
  'which',
  'with',
  'about',
  'chat',
  'work',
]);
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !FILLERS.has(word));
const names = (target: VoiceTarget, word: string) => {
  const text = `${target.title} ${target.label}`.toLowerCase();
  return word.length > 3 ? text.includes(word) : text.split(/[^a-z0-9]+/).includes(word);
};
/** Keep ties in catalog order, which is also the order spoken ordinals refer to. */
const namedTargets = (words: string[], targets: VoiceTarget[]) => {
  const scored = targets.map((target) => ({
    target,
    score: words.filter((word) => names(target, word)).length,
  }));
  const best = Math.max(0, ...scored.map(({ score }) => score));
  return best ? scored.filter(({ score }) => score === best).map(({ target }) => target) : [];
};
export interface VoiceChoice {
  query: string;
  targets: VoiceTarget[];
  clarification?: string;
}
export const asksConnect = (heard: string) => TO.test(heard);
/** Never turn a tie into a guess, including a provider with several existing sessions. */
export function resolveConnect(heard: string, targets: VoiceTarget[]): VoiceChoice | undefined {
  const match = TO.exec(heard);
  if (!match) return;
  const description = match[1]!.trim();
  const named = /^(?:the\s+)?(?:a\s+)?(?:(new)\s+)?(claude(?: code)?|codex)\b(.*)$/i.exec(
    description,
  );
  // A provider is a constraint wherever it is said, never just another scoring token.
  // Hearing both is uncertain (including a correction or a comparison); let the person choose.
  const providers = new Set(
    [...description.matchAll(/\b(claude(?: code)?|codex)\b/gi)].map((match) =>
      match[1]!.toLowerCase().startsWith('claude') ? 'claude' : 'codex',
    ),
  );
  const uncertainProvider = providers.size > 1 || description.match(EXCLUDED_PROVIDER) !== null;
  const provider = providers.size === 1 && !uncertainProvider ? [...providers][0] : undefined;
  const query =
    (named ? named[3]!.replace(/^[\s,:-]+/, '') : description).trim() ||
    (provider ? agentName(provider) : description);
  const mine = targets.filter((target) => !provider || target.provider === provider);
  const words = wordsOf(
    (named ? named[3]! : description)
      .replace(EXCLUDED_PROVIDER, '')
      .replace(/\b(?:claude(?: code)?|codex)\b/gi, ''),
  );
  const candidates = mine.filter((target) => (named?.[1] ? !target.thread : target.thread));
  // Without an agent or session noun, only a whole title is enough to change who hears us.
  if (
    !providers.size &&
    !/\b(?:session|agent|chat)\b/i.test(description) &&
    !(words.length && /\bwork\b/i.test(description))
  ) {
    const exact = candidates.filter((target) => {
      const title = wordsOf(target.title);
      return (
        title.length > 1 &&
        title.length === words.length &&
        title.every((word, i) => word === words[i])
      );
    });
    return exact.length ? { query, targets: exact } : undefined;
  }
  if (uncertainProvider)
    return {
      query: description,
      targets: words.length && !named?.[1] ? namedTargets(words, candidates) : candidates,
      clarification:
        providers.size > 1
          ? 'I heard Claude Code and Codex — which session? Pick one, or say the provider and session again.'
          : 'Which provider do you mean? Pick a session, or say the provider and session again.',
    };
  if (named?.[1]) return { query, targets: candidates };
  return {
    query,
    targets: words.length
      ? namedTargets(words, candidates)
      : provider
        ? candidates.length
          ? candidates
          : mine.filter((target) => !target.thread)
        : [],
  };
}
/** The catalog filters providers; spoken words are scored locally, not as a contiguous query. */
export function connectTargets(heard: string) {
  const description = TO.exec(heard)?.[1] ?? '';
  const providers = [
    ...new Set(
      [...description.matchAll(/\b(claude(?: code)?|codex)\b/gi)].map((match) =>
        match[1]!.toLowerCase().startsWith('claude') ? ('claude' as const) : ('codex' as const),
      ),
    ),
  ];
  const provider =
    providers.length === 1 && !description.match(EXCLUDED_PROVIDER) ? providers[0] : undefined;
  const words = wordsOf(description.replace(/\b(?:claude(?: code)?|codex|agent|new)\b/gi, ''));
  const named = providers.length || /\b(?:session|agent|chat|work)\b/i.test(description);
  return voiceTargets('', { provider, recent: named && words.length ? undefined : RECENT });
}
/** A follow-up can only choose within the exact list the person is looking at. */
export function saysChoice(heard: string, targets: VoiceTarget[]): VoiceTarget | undefined {
  const text = heard
    .toLowerCase()
    .replace(/[.!?,]/g, '')
    .trim();
  if (text.match(EXCLUDED_PROVIDER)) return;
  const ordinal =
    /^(?:please\s+)?(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?)(?:\s+(?:one|session))?(?:\s+please)?$/.exec(
      text,
    );
  if (ordinal) {
    const word = ordinal[1]!;
    const at = [
      'first',
      'second',
      'third',
      'fourth',
      'fifth',
      'sixth',
      'seventh',
      'eighth',
      'ninth',
      'tenth',
    ].indexOf(word);
    return targets[at >= 0 ? at : Number.parseInt(word, 10) - 1];
  }
  const provider = /\bcodex\b/.test(text)
    ? 'codex'
    : /\bclaude(?: code)?\b/.test(text)
      ? 'claude'
      : undefined;
  if (/\bcodex\b/.test(text) && /\bclaude\b/.test(text)) return;
  const mine = targets.filter((target) => !provider || target.provider === provider);
  const words = wordsOf(text.replace(/\b(?:codex|claude(?: code)?)\b/g, ''));
  const matches = words.length ? namedTargets(words, mine) : provider ? mine : [];
  return matches.length === 1 ? matches[0] : undefined;
}
export const choicePrompt = (count: number) =>
  `${count === 2 ? 'Two' : count === 3 ? 'Three' : count} match — which?`;

/** The session as the Mac sees it now, and with `command` how far that request's turn has got. */
export const readTarget = async (target: VoiceTarget, command?: string) => {
  const read = await post<VoiceRead>('/desk/voice', {
    device: target.device,
    thread: target.thread,
    ...(command && { command }),
  });
  if (!target.thread && read.thread) target.thread = read.thread;
  return read;
};

/** Says a request to the session; the answer is its command, or why it was not taken. */
const sending = new WeakMap<VoiceTarget, Promise<{ command: string } | { refused: string }>>();
export function tellTarget(target: VoiceTarget, text: string) {
  const sent = (sending.get(target) ?? Promise.resolve()).then(() => sendTarget(target, text));
  sending.set(target, sent);
  return sent.finally(() => {
    if (sending.get(target) === sent) sending.delete(target);
  });
}
async function sendTarget(
  target: VoiceTarget,
  text: string,
): Promise<{ command: string } | { refused: string }> {
  if (target.capabilities && !target.capabilities.message)
    return { refused: target.unavailable || 'This session cannot take messages.' };
  while (!target.thread && target.command) {
    const read = await readTarget(target, target.command).catch((error: Error) => error);
    if (read instanceof Error) return { refused: publicError(read) };
    if (!target.thread && read.turn?.state === 'unknown')
      return {
        refused: `I lost track of that start, so I can't say whether ${agentName(target.provider)} began.`,
      };
    if (read.turn?.failed || read.turn?.state === 'failed' || read.turn?.state === 'stopped') {
      target.command = undefined;
      return {
        refused:
          read.turn.answer ??
          (read.turn.state === 'stopped' ? 'The session was stopped.' : 'Could not start.'),
      };
    }
    if (!target.thread) await new Promise((done) => setTimeout(done, 500));
  }
  const sent = await post<{
    command: string;
    state: string;
    delivery?: string;
    reason?: string;
    thread?: string | null;
  }>(
    '/desk/commands',
    target.thread
      ? { device: target.device, thread: target.thread, kind: 'message', text, voice: true }
      : {
          device: target.device,
          project: target.project,
          provider: target.provider,
          kind: 'start',
          text,
          voice: true,
        },
  ).catch((error: Error) => ({ refused: publicError(error) }));
  if ('refused' in sent) return sent;
  // The first words started it: from here on the voice talks to that session.
  if (!target.thread && sent.thread) target.thread = sent.thread;
  if (sent.reason === 'asking_you')
    return { refused: 'Allow this folder on your Mac, then say it again.' };
  const state = delivery(sent);
  if (!['accepted', 'dispatched', 'delivered'].includes(state ?? ''))
    return {
      refused:
        state === 'refused'
          ? `${agentName(target.provider)} did not take that message.`
          : `I couldn't confirm ${agentName(target.provider)} got that message.`,
    };
  target.command = sent.command;
  return { command: sent.command };
}

type StopResult = 'requested' | 'idle' | 'refused' | 'unknown';
/** A completed command confirms delivery of the interrupt, not that the runtime has stopped. */
export async function stopTarget(target: VoiceTarget): Promise<StopResult> {
  if (!target.thread || target.capabilities?.stop === false) return 'refused';
  try {
    const receipt = await post<{ state?: string; delivery?: string; reason?: string }>(
      '/desk/commands',
      { device: target.device, thread: target.thread, kind: 'interrupt' },
    );
    if (receipt.reason === 'not_running') return 'idle';
    const state = delivery(receipt);
    if (state === 'refused') return 'refused';
    return ['accepted', 'dispatched', 'delivered'].includes(state ?? '') ? 'requested' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A person asking for Merv back, and nothing else. */
const BACK =
  /^\s*(?:(?:okay|ok|hey|please|now)[\s.!,]+)*(?:(?:go|switch|take me|get me|bring me|put me)\s+)?back\s+to\s+merv[\s.!,]*(?:please)?[\s.!,]*$/i;
export const saysBackToMerv = (heard: string) => BACK.test(heard);
