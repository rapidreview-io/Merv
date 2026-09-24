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
import { decodeCheckpoint, encodeCheckpoint } from './checkpoint.js';
import { piModelToolName } from './tool-names.js';
import type { PiBootstrap, PiCompletion, PiToolOutcome, PiWork } from './types.js';

const allowedTools = new Set([
  'project.get',
  'task.list',
  'artifact.list',
  'artifact.get',
  'artifact.read',
]);
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_RESPONSE_BYTES = 2_100_000;
const DELAY = 250;
const STARTUP_WAIT_MS = 60_000;
type ProgressEvent = { type: 'text' | 'progress'; text: string };

class WorkerHttpError extends Error {
  constructor(readonly status: number) {
    super('Worker authority unavailable');
  }
}

export interface WorkerOptions {
  workerId?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

const resources: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () =>
    'You are a read-only assistant. Only use the explicitly provided tools. Never propose running commands or modifying data.',
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {
    throw new Error('Resource discovery disabled');
  },
  reload: async () => {},
};

function validateWork(work: PiWork, bootstrap: PiBootstrap): void {
  if (
    work.command.conversationId !== bootstrap.conversationId ||
    work.command.epoch !== bootstrap.epoch ||
    work.command.runtimeId !== bootstrap.runtimeId ||
    !['waiting', 'starting'].includes(work.command.status) ||
    !work.command.messages.length ||
    work.command.messages.at(-1)?.role !== 'user' ||
    !work.command.expiresAt ||
    !Number.isFinite(Date.parse(work.command.expiresAt)) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(work.model) ||
    work.modelBaseUrl !== `${new URL(bootstrap.baseUrl).origin}/pi-model` ||
    !/^pir_[A-Za-z0-9_-]{43}$/.test(work.modelToken) ||
    work.tools.length > 5 ||
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
  if (name === 'artifact.get' || name === 'artifact.read')
    return (
      Object.keys(input).length === 1 &&
      typeof input.artifactId === 'string' &&
      input.artifactId.length > 0 &&
      input.artifactId.length <= 200
    );
  return Object.keys(input).length === 0;
}

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
  const request = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetchImpl(new URL(`/pi-worker/${path}`, url), {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${bootstrap.workerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new WorkerHttpError(response.status);
    }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Worker response exceeds limit');
    }
    if (!response.body) throw new Error('Invalid worker response');
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
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
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(parts, length).toString('utf8')) as T;
    } catch {
      throw new Error('Invalid worker response');
    }
  };
  const until = (time: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, time)));
  const startupDeadline = Math.min(Date.now() + STARTUP_WAIT_MS, Date.parse(bootstrap.expiresAt));
  let enrolled = false;
  while (!options.signal?.aborted && Date.now() < Date.parse(bootstrap.expiresAt)) {
    let work: PiWork | null;
    try {
      const startupSignal = !enrolled
        ? AbortSignal.timeout(Math.max(1, startupDeadline - Date.now()))
        : undefined;
      work = (
        await request<{ work: PiWork | null }>(
          'next',
          { workerId },
          startupSignal
            ? AbortSignal.any([startupSignal, ...(options.signal ? [options.signal] : [])])
            : options.signal,
        )
      ).work;
      enrolled = true;
    } catch (error) {
      if (options.signal?.aborted) return;
      if (
        enrolled ||
        Date.now() >= startupDeadline ||
        !(error instanceof WorkerHttpError
          ? error.status === 401 || error.status === 403 || error.status >= 500
          : error instanceof TypeError ||
            (error instanceof DOMException && error.name === 'TimeoutError'))
      )
        throw error;
      await until(Math.min(DELAY, startupDeadline - Date.now()));
      continue;
    }
    if (!work) {
      await until(Math.min(options.pollIntervalMs ?? 500, 1_000));
      continue;
    }
    validateWork(work, bootstrap);
    const commandId = work.command.id;
    if (seen.has(commandId)) throw new Error('Duplicate worker assignment');
    seen.add(commandId);
    const deadline = Math.min(Date.parse(bootstrap.expiresAt), Date.parse(work.command.expiresAt));
    const controller = new AbortController();
    const expire = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    const onStop = () => controller.abort();
    options.signal?.addEventListener('abort', onStop, { once: true });
    let begun = false;
    let savedResult = false;
    try {
      if (controller.signal.aborted) throw new Error('Turn expired');
      const reply = await request<{ apply: boolean }>(
        'begin',
        { workerId, commandId },
        controller.signal,
      );
      if (reply.apply !== true) continue;
      begun = true;
      const completion = await executeTurn(
        work,
        workerId,
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
    } catch {
      controller.abort();
      if (!savedResult && (begun || !options.signal?.aborted)) {
        try {
          await request('fail', { workerId, commandId });
        } catch {}
      }
    } finally {
      clearTimeout(expire);
      options.signal?.removeEventListener('abort', onStop);
    }
  }
}

async function executeTurn(
  work: PiWork,
  workerId: string,
  request: <T>(path: string, body: unknown, signal?: AbortSignal) => Promise<T>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  pollIntervalMs: number,
): Promise<PiCompletion> {
  const commandId = work.command.id;
  const checkpoint = work.checkpoint ? decodeCheckpoint(work.checkpoint) : null;
  const manager = checkpoint
    ? SessionManager.inMemory('/pi-worker', undefined, [
        checkpoint.header,
        ...checkpoint.entries,
      ] as Parameters<typeof SessionManager.inMemory>[2])
    : SessionManager.inMemory('/pi-worker');
  if (checkpoint && checkpoint.leafId !== manager.getLeafId()) {
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
    contextWindow: 32_000,
    maxTokens: 2048,
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
          { workerId, commandId, events: batch },
          signal,
        );
        if (receipt.accepted !== true) throw new Error('Conversation revoked');
      })
      .catch(() => {
        failure = new Error('Conversation revoked');
        session.abort().catch(() => {});
      })
      .finally(() => {
        if (sending === pending) sending = null;
        if (events.length && !failure && !signal.aborted) flush();
      });
    sending = pending;
  };
  const enqueue = (type: ProgressEvent['type'], text: string) => {
    if (failure || signal.aborted) return;
    for (let index = 0; index < text.length;) {
      const last = events.at(-1);
      if (last?.type === type && last.text.length < 8192) {
        const length = Math.min(8192 - last.text.length, text.length - index);
        last.text += text.slice(index, index + length);
        index += length;
      } else {
        if (events.length >= 64) {
          failure = new Error('Progress buffer full');
          session.abort().catch(() => {});
          return;
        }
        const length = Math.min(8192, text.length - index);
        events.push({ type, text: text.slice(index, index + length) });
        index += length;
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
      ) {
        failure = new Error('Tool arguments forbidden');
        session.abort().catch(() => {});
        throw new Error('Tool arguments forbidden');
      }
      let output: { result: unknown };
      try {
        output = await request<{ result: unknown }>(
          'tool',
          { workerId, commandId, name: tool.name, input },
          toolSignal ? AbortSignal.any([signal, toolSignal]) : signal,
        );
      } catch {
        failure = new Error('Tool unavailable');
        session.abort().catch(() => {});
        throw new Error('Tool unavailable');
      }
      if (signal.aborted || failure) throw new Error('Turn cancelled');
      if (!Object.hasOwn(output, 'result')) {
        failure = new Error('Invalid tool response');
        session.abort().catch(() => {});
        throw failure;
      }
      const canonicalCallId = callId.split('|')[0];
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(canonicalCallId) || outcomes.length >= 64) {
        failure = new Error('Invalid tool result');
        session.abort().catch(() => {});
        throw failure;
      }
      outcomes.push({
        callId: canonicalCallId,
        name: tool.name,
        input: input as PiToolOutcome['input'],
        output: output.result as PiToolOutcome['output'],
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(output.result) ?? 'null' }],
        details: undefined,
      };
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
    resourceLoader: resources,
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
      signal: outgoing.signal,
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
    if (failure || signal.aborted) throw new Error('Turn cancelled');
    const assistant = session.messages
      .slice(previousMessageCount)
      .filter((message) => message.role === 'assistant');
    if (
      assistant.some((message) => message.stopReason !== 'stop' && message.stopReason !== 'toolUse')
    )
      throw new Error('Model response failed');
    const messages = assistant.flatMap((message) => {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
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
      workerId,
      commandId,
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
