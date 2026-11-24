/**
 * Merv's one thread, read. In merv-desktop this read the person's stream from their Macs; in Merv
 * the same thread is fed by the project's own agent sessions (`/sessions/threads`) and this page's
 * conversation with the Agent. Each agent thread becomes the stream events the panel parts
 * already draw: a live one a working line, one that asked its owner (`session.ask_owner`) a
 * question with its worded answers, one that ended a done card. The project is one live card,
 * so "Now" says who is at work and what waits for the person. Nothing here writes but `answer`,
 * which sends the pressed choice to the asking agent's thread, as a typed answer would be.
 */
import { useCallback, useMemo } from 'react';
import type { StreamEvent } from '@merv/protocol/link';
import type { PiSnapshot } from '@merv/pi/models';
import type { ProjectThread, ProjectThreads } from '@merv/sessions/models';
import type { LocalLine, QuestionRow, ThreadCard } from '../panel/one-thread';
import type { MervTurn } from '../panel/one-thread-entries';
import type { ReadReport } from '../panel/one-thread-view';
import { accountRequest, refreshTools, useTool } from '../api';
import { capital, words } from '../components';
import { useSession } from '../session';

export interface ThreadData {
  events: StreamEvent[];
  cards: ThreadCard[];
  /** The first read has answered: an empty thread is then really empty. */
  ready: boolean;
  /** Merv keeps no older page of this thread: what the project's agents are doing is all of it. */
  older: boolean;
  reading: boolean;
  earlier(): void;
}

/** How a thread's agent is named: its work, as the Agents page names it. */
export const titleOf = (thread: ProjectThread) =>
  [capital(words(thread.state)), thread.name].filter(Boolean).join(' · ') || 'Agent';
const newest = (thread: ProjectThread) => thread.visits.at(-1);
const endedOf = (thread: ProjectThread) => {
  const visit = newest(thread);
  return visit?.endedAt ?? visit?.startedAt ?? visit?.offeredAt ?? '';
};

/** How a visit ended, in words, where its agent left no closing words of its own. */
const endWords = (outcome?: string) =>
  !outcome
    ? 'It ended.'
    : outcome === 'submitted'
      ? 'It handed its work on.'
      : `It ended: ${words(outcome)}.`;
/** The ended agents the thread tells of: the newest few, so what is live stays in view. */
const ENDED_SHOWN = 6;

/** The project's agent threads as the stream the thread is drawn from, oldest first. */
export function threadEvents(threads: readonly ProjectThread[], project: string): StreamEvent[] {
  const events: Omit<StreamEvent, 'seq'>[] = [];
  for (const thread of threads) {
    const visit = newest(thread);
    if (!visit) continue;
    const from = {
      kind: 'worker' as const,
      id: thread.id,
      title: titleOf(thread),
      ...(visit.harness && { provider: visit.harness }),
    };
    const base = { project, from, ref: { session: thread.id } };
    if (thread.status === 'live' || thread.question)
      events.push({
        ...base,
        local: `${thread.id}:start`,
        at: visit.startedAt ?? visit.offeredAt,
        type: 'step',
        text: 'Working',
      });
    if (thread.question)
      events.push({
        ...base,
        local: `${thread.id}:${thread.question.id}`,
        at: thread.question.askedAt,
        type: 'question',
        text: thread.question.question,
        ref: { session: thread.id, request: thread.question.id },
        ask: {
          kind: 'question',
          title: thread.question.question,
          ...(thread.question.options && { options: thread.question.options }),
        },
      });
    else if (thread.status !== 'live' && visit.endedAt) {
      const outcome = /fail|crash|error|expired/.test(visit.outcome ?? '')
        ? ('failed' as const)
        : /halt|stop|cancel/.test(visit.outcome ?? '')
          ? ('stopped' as const)
          : ('finished' as const);
      events.push({
        ...base,
        local: `${thread.id}:${visit.sessionId}:done`,
        at: visit.endedAt,
        type: 'done',
        text: titleOf(thread),
        outcome,
        card: { agent: thread.id, title: titleOf(thread), outcome, said: endWords(visit.outcome) },
      });
    }
  }
  const ended = events
    .filter((event) => event.type === 'done')
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(ENDED_SHOWN);
  return events
    .filter((event) => !ended.includes(event))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((event, index) => ({ ...event, seq: index + 1 }));
}

/** The project as one live card: who works, and what waits for the person. */
export function projectCard(
  threads: readonly ProjectThread[],
  project: string,
  events: StreamEvent[],
): ThreadCard {
  const asking = threads.filter((thread) => thread.question);
  const seqOf = (thread: ProjectThread) =>
    events.find((event) => event.type === 'question' && event.ref?.session === thread.id)?.seq;
  return {
    project,
    device: 'merv',
    manager: { thread: '', status: 'idle' },
    rev: threads.length,
    updatedAt: new Date().toISOString(),
    inFlight: threads
      .filter((thread) => thread.status === 'live' || thread.question)
      .slice(0, 12)
      .map((thread) => ({
        id: thread.id,
        kind: 'worker' as const,
        ...(newest(thread)?.harness && { provider: newest(thread)!.harness }),
        title: titleOf(thread),
        state: thread.question ? ('needs you' as const) : ('working' as const),
        since: thread.question?.askedAt ?? newest(thread)?.startedAt ?? endedOf(thread),
      })),
    waitingOnYou: asking.slice(0, 12).map((thread) => ({
      id: thread.question!.id,
      from: thread.id,
      title: thread.question!.question.slice(0, 200),
      ...(seqOf(thread) !== undefined && { seq: seqOf(thread) }),
    })),
    recent: [],
  };
}

/** The project's agents, read as the Agents page reads them, quicker while one works. */
export function useThreadData(on = true): ThreadData {
  const { project } = useSession();
  const read = useTool<ProjectThreads>(on ? '/sessions/threads' : null, {}, { every: 8000 });
  const threads = read.data?.threads;
  return useMemo(() => {
    const list = threads ?? [];
    const events = threadEvents(list, project.name);
    return {
      events,
      cards: list.length ? [projectCard(list, project.name, events)] : [],
      ready: !!read.data || !!read.error,
      older: false,
      reading: false,
      earlier: () => undefined,
    };
  }, [threads, read.data, read.error, project.name]);
}

/** One id per answer: the same choice pressed again on the same question (a retry after a send
 *  that did not answer, or a second press) is the same request, which the thread takes once. */
const answers = new Map<string, string>();
const requestId = (key: string) => {
  let id = answers.get(key);
  if (!id) {
    id =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    answers.set(key, id);
  }
  return id;
};

/** A choice pressed on an agent's question, sent to its thread as the person's answer. */
/** The person's answer to the question an agent asked, sent to its thread as a message, which is
 *  what answers `session.ask_owner`. `asked` names the question, so a retry is the same request. */
export async function answerThread(thread: string, asked: string, text: string) {
  await accountRequest(`/sessions/threads/${encodeURIComponent(thread)}/messages`, {
    method: 'POST',
    scoped: true,
    body: { body: text, requestId: requestId(`${thread}:${asked}:${text}`) },
  });
  refreshTools(
    '/sessions/threads',
    `/sessions/threads/${encodeURIComponent(thread)}/messages`,
    'ui.home',
  );
  return true;
}

/** A choice pressed on an agent's question in the thread, sent as the person's answer. */
export function useAnswer() {
  return useCallback(
    (row: QuestionRow, choice: string) =>
      answerThread(row.who.id, row.request ?? String(row.seq), choice),
    [],
  );
}

/** This page's conversation with the Agent as lines, each with where the conversation keeps it. */
export function localLines(snapshot: PiSnapshot | null | undefined): LocalLine[] {
  return [...(snapshot?.commands ?? [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((command) =>
      command.messages.flatMap((message, index): LocalLine[] =>
        message.text.trim()
          ? [
              {
                key: `${command.id}:${index}`,
                role: message.role,
                text: message.text,
                at: command.createdAt,
                command: command.id,
                message: index,
              },
            ]
          : [],
      ),
    );
}

/** What a call answered, as its step opens to it: its text, else its JSON, cut to what reads. */
const OUTPUT_MOST = 4_000;
const outputWords = (output: unknown) => {
  const text = typeof output === 'string' ? output : (JSON.stringify(output, null, 2) ?? '');
  return text.length > OUTPUT_MOST ? `${text.slice(0, OUTPUT_MOST)}\n…` : text;
};

/** The Agent's own tool calls, turn by turn, so the thread says what it did ("Read the board"),
 *  one quiet line per run of a kind, never its tools' own words. */
export function mervTurns(snapshot: PiSnapshot | null | undefined): MervTurn[] {
  return (snapshot?.commands ?? []).flatMap((command): MervTurn[] =>
    command.outcomes?.length
      ? [
          {
            command: command.id,
            steps: command.outcomes.map((outcome, at) => {
              const input = outcome.input as { action?: unknown } | null,
                output = outcome.output as { error?: unknown } | null;
              return {
                id: `${command.id}:${outcome.callId || at}`,
                tool: outcome.name.replace(/\./g, '_'),
                ...(typeof input?.action === 'string' && { action: input.action }),
                ...(!!(output && typeof output === 'object' && output.error) && { failed: true }),
                ...(outcome.output !== undefined && { output: outputWords(outcome.output) }),
              };
            }),
          },
        ]
      : [],
  );
}

/** A finished agent's report, for its done card: its thread's newest words to its owner. */
export const readReport: ReadReport = async ({ agent }) => {
  if (!agent) throw new Error('This report cannot be read here.');
  const read = await accountRequest<{
    messages: { body: string; reply?: string | null; createdAt: string }[];
  }>(`/sessions/threads/${encodeURIComponent(agent)}/messages`, { scoped: true });
  const said = read.messages.at(-1)?.reply ?? read.messages.at(-1)?.body;
  if (!said) throw new Error('This agent left no report.');
  return { said, files: [] };
};
