import { randomUUID } from 'node:crypto';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  Type,
  type Model,
} from '@earendil-works/pi-ai';
import { streamSimple as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { decodeCheckpoint, encodeCheckpoint, type WorkerCheckpoint } from './checkpoint.js';
import { piModelToolName } from './tool-names.js';
import type {
  PiBootstrap,
  PiCompletion,
  PiNextReply,
  PiToolOutcome,
  PiTurnInput,
  PiWork,
} from './types.js';

const allowedTools = new Set([
  'project.get',
  'task.list',
  'artifact.list',
  'artifact.get',
  'artifact.read',
  'machine.switch',
]);
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_RESPONSE_BYTES = 2_100_000;
const DELAY = 250;
const STARTUP_WAIT_MS = 60_000;
// The server may hold /next open until work exists.
const NEXT_TIMEOUT_MS = 30_000;
// A relay request carries at most 512 KiB in 512 items of 100k characters and asks for at most 4096
// tokens. History and tool output leave room for a turn's prompt, its answers and JSON re-escaping.
const MAX_OUTPUT_TOKENS = 4096;
const TOOL_OUTPUT_BYTES = 64_000;
const HISTORY_BYTES = 128_000;
const HISTORY_ITEMS = 300;
type ProgressEvent = { type: 'text' | 'progress'; text: string };
type Post = <T>(path: string, body: unknown, signal?: AbortSignal, tries?: number) => Promise<T>;

class WorkerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: { message?: unknown },
  ) {
    super(`Worker request failed with HTTP ${status}`);
  }
}
const transient = (error: unknown) =>
  error instanceof WorkerHttpError
    ? error.status === 429 || error.status >= 500
    : error instanceof TypeError ||
      (error instanceof DOMException && error.name === 'TimeoutError');

/** A boot milestone, in milliseconds since this process started, for the supervisor's diagnostics. */
export const mark = (milestone: string) =>
  process.stderr.write(`Pi worker ${milestone} ${Math.round(performance.now())} ms\n`);

/** Our own messages carry no credential or URL; any other cause is reported only as unexpected. */
export function cause(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  return /^[A-Za-z0-9 ()]{1,120}$/.test(text) ? text : 'Unexpected error';
}

export interface WorkerOptions {
  workerId?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

/** A turn's notes (its machine, a failed move) follow the fixed prompt for that turn only. */
const resources = (notes: string[]): ResourceLoader => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () =>
    'You are a read-only assistant. Only use the explicitly provided tools. Never propose running commands or modifying data.',
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => notes,
  getAppendSystemPromptSources: () => [],
  extendResources: () => {
    throw new Error('Resource discovery disabled');
  },
  reload: async () => {},
});

function validateWork(work: PiWork, bootstrap: PiBootstrap): void {
  if (
    work.command.hostId !== bootstrap.hostId ||
    work.command.epoch !== bootstrap.epoch ||
    work.command.runtimeId !== bootstrap.runtimeId ||
    !['waiting', 'starting'].includes(work.command.status) ||
    !work.command.messages.length ||
    work.command.messages.at(-1)?.role !== 'user' ||
    !work.command.expiresAt ||
    !Number.isFinite(Date.parse(work.command.expiresAt)) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(work.model) ||
    work.modelBaseUrl !== `${new URL(bootstrap.baseUrl).origin}/pi-model` ||
    !/^pir_[A-Za-z0-9_-]{43}$/.test(work.modelToken) ||
    !Array.isArray(work.notes) ||
    work.notes.length > 4 ||
    work.notes.some((note) => typeof note !== 'string' || note.length > 300) ||
    new Set(work.tools.map((tool) => tool.name)).size !== work.tools.length ||
    work.tools.some(
      (tool) =>
        !allowedTools.has(tool.name) ||
        typeof tool.description !== 'string' ||
        !tool.inputSchema ||
        typeof tool.inputSchema !== 'object' ||
        Array.isArray(tool.inputSchema) ||
        (tool.inputSchema as Record<string, unknown>).type !== 'object',
    )
  )
    throw new Error('Invalid worker assignment');
}

function allowedInput(name: string, input: Record<string, unknown>): boolean {
  if (name === 'machine.switch')
    return (
      Object.keys(input).sort().join(',') === 'machine,reason' &&
      typeof input.machine === 'string' &&
      typeof input.reason === 'string'
    );
  if (name === 'artifact.get' || name === 'artifact.read')
    return (
      Object.keys(input).length === 1 &&
      typeof input.artifactId === 'string' &&
      input.artifactId.length > 0 &&
      input.artifactId.length <= 200
    );
  return Object.keys(input).length === 0;
}

/** Runs up to `bootstrap.slots` turns at once, of any of the host's conversations, until the slot
 * expires, the server retires it, or `options.signal` stops it; running turns always finish. */
export async function runPiWorker(
  bootstrap: PiBootstrap,
  options: WorkerOptions = {},
): Promise<void> {
  const workerId = options.workerId ?? randomUUID();
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(bootstrap.baseUrl);
  if (
    !(url.protocol === 'https:' || (url.protocol === 'http:' && localHosts.has(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !Number.isFinite(Date.parse(bootstrap.expiresAt)) ||
    Date.parse(bootstrap.expiresAt) <= Date.now() ||
    !/^piw_flt_[A-Za-z0-9]+\.[A-Za-z0-9_-]{43}$/.test(bootstrap.workerToken)
  )
    throw new Error('Invalid worker bootstrap');
  const seen = new Set<string>();
  const send = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetchImpl(new URL(`/pi-worker/${path}`, url), {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${bootstrap.workerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        AbortSignal.timeout(path === 'next' ? NEXT_TIMEOUT_MS : 10_000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Worker response exceeds limit');
    }
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    try {
      while (reader) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw new Error('Worker response exceeds limit');
        }
        parts.push(part.value);
      }
    } finally {
      reader?.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(parts, length).toString('utf8'));
    } catch {
      if (response.ok) throw new Error('Invalid worker response');
    }
    if (!response.ok) throw new WorkerHttpError(response.status, (value as { error?: {} })?.error);
    return value as T;
  };
  const request: Post = async (path, body, signal, tries = 1) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await send(path, body, signal);
      } catch (error) {
        if (attempt >= tries || signal?.aborted || !transient(error)) throw error;
        await until(DELAY * 2 ** attempt);
      }
    }
  };
  const until = (time: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, time)));
  const startupDeadline = Math.min(Date.now() + STARTUP_WAIT_MS, Date.parse(bootstrap.expiresAt));
  const turn = async (work: PiWork, ids: PiTurnInput, begun: () => void) => {
    const deadline = Math.min(Date.parse(bootstrap.expiresAt), Date.parse(work.command.expiresAt));
    const controller = new AbortController();
    const expire = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    const onStop = () => controller.abort();
    options.signal?.addEventListener('abort', onStop, { once: true });
    let applied = false;
    let savedResult = false;
    try {
      validateWork(work, bootstrap);
      if (seen.has(ids.commandId)) throw new Error('Duplicate worker assignment');
      seen.add(ids.commandId);
      if (controller.signal.aborted) throw new Error('Turn expired');
      const reply = await request<{ apply: boolean }>('begin', ids, controller.signal);
      if (reply.apply !== true) return;
      applied = true;
      begun();
      const completion = await executeTurn(
        work,
        ids,
        request,
        fetchImpl,
        controller.signal,
        options.pollIntervalMs ?? 1_000,
      );
      while (!controller.signal.aborted) {
        try {
          const saved = await request<{ saved: boolean }>(
            'complete',
            completion,
            controller.signal,
          );
          if (saved.saved === true) {
            savedResult = true;
            break;
          }
          if (saved.saved !== false) throw new Error('Invalid completion receipt');
        } catch (error) {
          if (controller.signal.aborted || (error instanceof WorkerHttpError && error.status < 500))
            throw error;
        }
        await until(DELAY);
      }
      if (controller.signal.aborted && !savedResult) throw new Error('Turn expired');
    } catch (error) {
      controller.abort();
      process.stderr.write(`Pi worker turn failed: ${cause(error)}\n`);
      if (!savedResult && (applied || !options.signal?.aborted)) {
        try {
          await request('fail', ids, undefined, 3);
        } catch {}
      }
    } finally {
      begun();
      clearTimeout(expire);
      options.signal?.removeEventListener('abort', onStop);
    }
  };
  // One /next is open while a slot is free; a turn is begun before the next is asked for, so a
  // prompt is never delivered twice to this worker.
  const running = new Set<Promise<void>>();
  let enrolled = false;
  let probe: string | undefined;
  let retire = false;
  try {
    while (!retire && !options.signal?.aborted && Date.now() < Date.parse(bootstrap.expiresAt)) {
      if (running.size >= bootstrap.slots) {
        await Promise.race(running);
        continue;
      }
      let reply: PiNextReply;
      const asked = Date.now();
      try {
        const startupSignal = !enrolled
          ? AbortSignal.timeout(Math.max(1, startupDeadline - Date.now()))
          : undefined;
        reply = await request<PiNextReply>(
          'next',
          probe ? { workerId, probe } : { workerId },
          startupSignal
            ? AbortSignal.any([startupSignal, ...(options.signal ? [options.signal] : [])])
            : options.signal,
        );
        if (!enrolled) mark('enrolled');
        enrolled = true;
      } catch (error) {
        if (options.signal?.aborted) break;
        // Before enrollment the grant may not be visible yet; after it, only an outage is waited out.
        if (
          enrolled
            ? !transient(error)
            : Date.now() >= startupDeadline ||
              !(
                transient(error) ||
                (error instanceof WorkerHttpError && [401, 403].includes(error.status))
              )
        )
          throw error;
        await until(enrolled ? 1_000 : Math.min(DELAY, startupDeadline - Date.now()));
        continue;
      }
      // The probe proves this worker ready for a move (echoed once, at once); retire drains it.
      ({ probe } = reply);
      retire = reply.retire === true;
      const { work } = reply;
      if (work) {
        // An assignment without a command stops the worker, as any malformed reply does.
        const { conversationId, id: commandId } = work.command;
        await new Promise<void>((begun) => {
          const task = turn(work, { workerId, conversationId, commandId }, begun).finally(() =>
            running.delete(task),
          );
          running.add(task);
        });
      }
      // A held (long-polled) request asks again at once; a short-polling server keeps the interval.
      else if (!probe && !retire)
        await until(asked + Math.min(options.pollIntervalMs ?? 500, 1_000) - Date.now());
    }
  } finally {
    await Promise.all(running);
  }
}

async function executeTurn(
  work: PiWork,
  ids: PiTurnInput,
  request: Post,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  pollIntervalMs: number,
): Promise<PiCompletion & PiTurnInput> {
  const checkpoint = work.checkpoint ? decodeCheckpoint(work.checkpoint) : null;
  const contextWindow = Object.hasOwn(OPENAI_MODELS, work.model)
    ? OPENAI_MODELS[work.model as keyof typeof OPENAI_MODELS].contextWindow
    : 32_000;
  // A token is at least a byte, so a smaller window keeps history within it too.
  const entries = checkpoint && recent(checkpoint, Math.min(HISTORY_BYTES, contextWindow));
  const restored = checkpoint ? [checkpoint.header, ...entries!] : undefined;
  const manager = SessionManager.inMemory(
    '/pi-worker',
    undefined,
    restored as Parameters<typeof SessionManager.inMemory>[2],
  );
  if (checkpoint && entries === checkpoint.entries && checkpoint.leafId !== manager.getLeafId()) {
    if (checkpoint.leafId) manager.branch(checkpoint.leafId);
    else manager.resetLeaf();
  }
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey('openai', work.modelToken);
  const model: Model<'openai-responses'> = {
    id: work.model,
    name: work.model,
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: work.modelBaseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: MAX_OUTPUT_TOKENS,
  };
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    cacheWarming: 'off',
    transport: 'sse',
    defaultTools: [],
    enableSkillCommands: false,
  });
  const events: ProgressEvent[] = [];
  const outcomes: PiToolOutcome[] = [];
  let toolBytes = Math.min(TOOL_OUTPUT_BYTES, contextWindow);
  let failure: Error | null = null;
  let sending: Promise<void> | null = null;
  const flush = (heartbeat = false) => {
    if (sending || (!events.length && !heartbeat) || failure || signal.aborted) return;
    const batch = events.splice(0, 32);
    const pending = Promise.resolve()
      .then(async () => {
        if (signal.aborted) return;
        const receipt = await request<{ accepted: boolean }>(
          'progress',
          { ...ids, events: batch },
          signal,
          3,
        );
        if (receipt.accepted !== true) throw new Error('Conversation revoked');
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error('Conversation revoked');
        session.abort().catch(() => {});
      })
      .finally(() => {
        if (sending === pending) sending = null;
        if (events.length && !failure && !signal.aborted) flush();
      });
    sending = pending;
  };
  // The end of at most `room` code units of text from index, never inside a surrogate pair: Main
  // refuses an event holding half an emoji.
  const cut = (text: string, index: number, room: number) => {
    const end = Math.min(index + room, text.length);
    const code = text.charCodeAt(end - 1);
    return end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
  };
  const enqueue = (type: ProgressEvent['type'], text: string) => {
    if (failure || signal.aborted) return;
    for (let index = 0; index < text.length;) {
      const last = events.at(-1);
      const end = last?.type === type ? cut(text, index, 8192 - last.text.length) : index;
      if (last && end > index) {
        last.text += text.slice(index, end);
        index = end;
      } else {
        if (events.length >= 64) {
          failure = new Error('Progress buffer full');
          session.abort().catch(() => {});
          return;
        }
        const next = cut(text, index, 8192);
        events.push({ type, text: text.slice(index, next) });
        index = next;
      }
    }
    if (events.at(-1)?.text.length === 8192 || events.length >= 32) flush();
  };
  const tools: ToolDefinition[] = work.tools.map((tool) => ({
    name: piModelToolName(tool.name),
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe<Record<string, unknown>>({
      ...(tool.inputSchema as Record<string, unknown>),
      required: Array.isArray((tool.inputSchema as Record<string, unknown>).required)
        ? ((tool.inputSchema as Record<string, unknown>).required as string[]).filter(
            (name) => name !== 'projectId',
          )
        : undefined,
    }),
    async execute(callId, input, toolSignal) {
      if (signal.aborted || failure) throw new Error('Turn cancelled');
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        !allowedInput(tool.name, input as Record<string, unknown>)
      )
        throw new Error('Tool arguments are not allowed');
      let output: { result: unknown };
      try {
        output = await request<{ result: unknown }>(
          'tool',
          { ...ids, name: tool.name, input },
          toolSignal ? AbortSignal.any([signal, toolSignal]) : signal,
          3,
        );
        if (!Object.hasOwn(output ?? {}, 'result')) throw new Error('Invalid tool response');
      } catch (error) {
        // Lost authority ends the turn; any other failure is a tool result the model can answer.
        if (error instanceof WorkerHttpError && [401, 403, 409].includes(error.status)) {
          failure = new Error('Tool authority unavailable');
          session.abort().catch(() => {});
        }
        if (signal.aborted || failure) throw new Error('Turn cancelled');
        const detail = error instanceof WorkerHttpError ? error.detail?.message : undefined;
        throw new Error(typeof detail === 'string' ? detail : cause(error));
      }
      if (signal.aborted || failure) throw new Error('Turn cancelled');
      const canonicalCallId = callId.split('|')[0];
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(canonicalCallId) || outcomes.length >= 64) {
        failure = new Error('Invalid tool result');
        session.abort().catch(() => {});
        throw failure;
      }
      const text = JSON.stringify(output.result) ?? 'null';
      const size = Buffer.byteLength(text);
      const kept = Buffer.from(text).subarray(0, toolBytes).toString();
      const shown =
        size <= toolBytes
          ? text
          : `${kept}\n[${size - toolBytes} bytes omitted: tool output limit]`;
      toolBytes = Math.max(0, toolBytes - size);
      outcomes.push({
        callId: canonicalCallId,
        name: tool.name,
        input: input as PiToolOutcome['input'],
        output: (shown === text
          ? output.result
          : { truncated: true, text: kept }) as PiToolOutcome['output'],
      });
      return { content: [{ type: 'text', text: shown }], details: undefined };
    },
  }));
  const { session } = await createAgentSession({
    cwd: '/pi-worker',
    modelRuntime: runtime,
    model,
    scopedModels: [{ model, thinkingLevel: 'off' }],
    thinkingLevel: 'off',
    noTools: 'all',
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    resourceLoader: resources(work.notes),
    sessionManager: manager,
    settingsManager: settings,
  });
  const modelEndpoint = new URL('/pi-model/responses', work.modelBaseUrl);
  const relayFetch: typeof fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    if (outgoing.url !== modelEndpoint.href || outgoing.method !== 'POST')
      throw new Error('Forbidden model destination');
    return fetchImpl(modelEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${work.modelToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: await outgoing.text(),
      // A Request's own signal stops following its source once that Request is collected.
      signal: init?.signal ?? outgoing.signal,
    });
  };
  session.agent.streamFunction = (_model, context, options) =>
    streamOpenAIResponses(model, context, {
      signal: options?.signal,
      reasoning: options?.reasoning,
      toolChoice: options?.toolChoice,
      maxTokens: options?.maxTokens,
      apiKey: work.modelToken,
      fetch: relayFetch,
      env: {},
      cacheRetention: 'none',
      maxRetries: 0,
      transport: 'sse',
    });
  const previousMessageCount = session.messages.length;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
      enqueue('text', event.assistantMessageEvent.delta);
  });
  const pulse = setInterval(
    () => {
      if (signal.aborted) {
        failure = new Error('Turn cancelled');
        session.abort().catch(() => {});
        return;
      }
      flush(true);
    },
    Math.max(250, Math.min(pollIntervalMs, 1_000)),
  );
  try {
    const prompt = work.command.messages.at(-1)?.text;
    if (!prompt || signal.aborted) throw new Error('Missing user prompt or expired turn');
    await session.prompt(prompt, { expandPromptTemplates: false });
    while (!failure && !signal.aborted && (events.length || sending)) {
      flush();
      if (sending) await sending;
    }
    if (failure || signal.aborted) throw failure ?? new Error('Turn cancelled');
    const assistant = session.messages
      .slice(previousMessageCount)
      .filter((message) => message.role === 'assistant');
    const failed = assistant.find(
      (message) => !['stop', 'toolUse', 'length'].includes(message.stopReason),
    );
    if (failed) throw new Error(`Model response failed (${failed.stopReason})`);
    const messages = assistant.flatMap((message) => {
      const text = [
        message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
        // A cut-off tool call is failed back to the model, which then answers.
        message.stopReason === 'length' && !message.content.some((part) => part.type === 'toolCall')
          ? '[Answer cut off at the response length limit.]'
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return text ? [{ role: 'assistant' as const, text }] : [];
    });
    if (
      !messages.length ||
      messages.length > 128 ||
      messages.some((message) => message.text.length > 128_000) ||
      outcomes.length > 64
    )
      throw new Error('Invalid model result');
    const saved = encodeCheckpoint(manager);
    return {
      ...ids,
      messages,
      outcomes,
      checkpoint: saved.content,
      checkpointHash: saved.hash,
    };
  } finally {
    clearInterval(pulse);
    unsubscribe();
    session.dispose();
  }
}

/** The whole tree while its active branch fits a request; otherwise the newest whole exchanges that do. */
function recent(checkpoint: WorkerCheckpoint, bytes: number): WorkerCheckpoint['entries'] {
  type Entry = WorkerCheckpoint['entries'][number] & {
    message?: { role: string; content: unknown[] };
  };
  const byId = new Map(checkpoint.entries.map((entry) => [entry.id, entry as Entry]));
  const branch: Entry[] = [];
  for (let entry = byId.get(checkpoint.leafId ?? ''); entry; entry = byId.get(entry.parentId ?? ''))
    branch.unshift(entry);
  let start = branch.length;
  for (let index = branch.length - 1, size = 0, items = 0; index >= 0; index--) {
    const { message } = branch[index];
    size += Buffer.byteLength(JSON.stringify(branch[index]));
    items += message?.role === 'assistant' ? message.content.length : 1;
    if (size > bytes || items > HISTORY_ITEMS) break;
    if (index === 0 || message?.role === 'user') start = index;
  }
  if (start === 0) return checkpoint.entries;
  return branch.slice(start).map((entry, index) => (index ? entry : { ...entry, parentId: null }));
}
