import { filterAsync, plain } from '@merv/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CallToolResultSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { MervError, type Caller, type Data, type Scope } from '@merv/contracts';
import type {
  AnyToolDefinition,
  RemoteToolDefinition,
  ToolCatalog,
  ToolDescription,
  ToolInvocation,
  Tools,
} from './types.js';
import { cloneJson, compileSchema } from './schema.js';
import type { ConversationToolPolicy, SessionToolPolicy, ToolPolicy } from '@merv/contracts';

export type { ToolDescription } from './types.js';
export function isRemoteTool(tool: AnyToolDefinition): tool is RemoteToolDefinition {
  return !!tool && typeof tool === 'object' && 'kind' in tool && tool.kind === 'mcp';
}

/** Canonical public metadata; project selection is a transport envelope, not handler input. */
export function describeTool(tool: AnyToolDefinition): ToolDescription {
  if (isRemoteTool(tool)) {
    const { handler: _handler, kind: _kind, ...description } = tool;
    return structuredClone(description);
  }
  const schema = zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none', target: 'jsonSchema7' });
  if (!('type' in schema) || schema.type !== 'object')
    throw new MervError('invalid_tool', 'Tool input must be an object');
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      ...schema,
      type: 'object',
      properties: {
        ...('properties' in schema ? schema.properties : {}),
        projectId: {
          type: 'string',
          minLength: 1,
          description:
            'Project scope. Human sessions and account machine keys must select a project; actor tokens and project machine keys default to their fixed project. Access is checked by the server.',
        },
      },
    },
    annotations: { readOnlyHint: tool.readOnly ?? false, openWorldHint: false },
  };
}

interface Entry {
  name: string;
  definition: AnyToolDefinition;
  description: ToolDescription;
  parse(input: unknown): unknown;
  complete(value: unknown): ToolInvocation;
  running: Set<Promise<ToolInvocation>>;
  remote?: { mountId: string; toolName: string };
}
interface CatalogState {
  active: boolean;
  current: Set<Entry>;
  owned: Set<Entry>;
}
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const publishedNamePattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;
const mountPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const namespace = '_';
/** Identity, not provider: re-registering the same provider still retires calls it began. */
type SessionRegistration = { provider: SessionToolPolicy };
type ConversationRegistration = { provider: ConversationToolPolicy };

/** Reserved even while a catalog is absent, so remote arguments keep their meaning. */
export const isMountedToolName = (name: string): boolean => name.startsWith(namespace);

/** Registrations own admission and draining; remote catalogs swap as one validated generation. */
export class ToolRegistry implements Tools {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<Promise<ToolInvocation>>();
  private readonly catalogs = new Map<string, CatalogState>();
  private sessions?: SessionRegistration;
  private conversations?: ConversationRegistration;
  private stopping = false;

  constructor(
    private readonly scope: Pick<Scope, 'require'>,
    private readonly access?: Pick<ToolPolicy, 'allows' | 'require'>,
    /** Runs a read-only tool's handler in a snapshot scope: no writer lock, writes refused. */
    private readonly readScope?: <T>(fn: () => Promise<T>) => Promise<T>,
  ) {}

  private open(): void {
    if (this.stopping) throw new MervError('unavailable', 'Tool registry is stopping', 503);
  }

  private prepare(definition: AnyToolDefinition, remote?: Entry['remote']): Entry {
    if (!publishedNamePattern.test(definition.name))
      throw new MervError('invalid_tool', 'Invalid tool name');
    if (typeof definition.handler !== 'function')
      throw new MervError('invalid_tool', 'Tool handler is required');
    if (isRemoteTool(definition)) {
      if (!remote)
        throw new MervError('catalog_required', 'Remote tools require a catalog identity');
      return this.prepareRemote(definition, remote);
    }
    // Schema changes require a new registration, keeping validation paired with its catalog.
    const inputSchema = definition.inputSchema;
    return {
      name: definition.name,
      definition,
      description: describeTool({ ...definition, inputSchema }),
      async parse(input) {
        const parsed = await inputSchema.safeParseAsync(input);
        if (!parsed.success)
          throw new MervError(
            'invalid_input',
            'Tool input failed validation',
            400,
            parsed.error.issues.map(({ path, message }) => ({ path, message })),
          );
        return parsed.data;
      },
      complete: (value) => ({ format: 'json', value }),
      running: new Set(),
    };
  }

  private prepareRemote(input: RemoteToolDefinition, remote: NonNullable<Entry['remote']>): Entry {
    const { kind: _kind, handler, ...metadata } = input;
    let description: ToolDescription;
    try {
      description = cloneJson(metadata);
    } catch {
      throw new MervError('invalid_tool', 'Remote tool metadata must be JSON');
    }
    if (!ToolSchema.safeParse(description).success)
      throw new MervError('invalid_tool', 'Remote tool description is not valid MCP');
    if (description.execution?.taskSupport && description.execution.taskSupport !== 'forbidden') {
      throw new MervError(
        'unsupported_execution',
        'Remote MCP tasks are not supported; taskSupport must be absent or forbidden',
      );
    }
    const validate = compileSchema(description.inputSchema);
    const validateOutput =
      description.outputSchema === undefined ? undefined : compileSchema(description.outputSchema);
    const definition: RemoteToolDefinition = { ...description, kind: 'mcp', handler };
    return {
      name: definition.name,
      definition,
      description,
      remote,
      running: new Set(),
      parse(input) {
        let data: unknown;
        try {
          data = cloneJson(input);
        } catch {
          throw new MervError('invalid_input', 'Remote tool input must be JSON');
        }
        if (!validate(data))
          throw new MervError(
            'invalid_input',
            'Tool input failed JSON Schema validation',
            400,
            validate.errors?.map(({ instancePath, keyword, message }) => ({
              path: instancePath,
              keyword,
              message,
            })),
          );
        return data;
      },
      complete(value) {
        let result: unknown;
        try {
          result = cloneJson(value);
        } catch {
          throw new MervError('invalid_remote_result', 'Remote tool result must be JSON', 502);
        }
        const parsed = CallToolResultSchema.safeParse(result);
        if (!parsed.success)
          throw new MervError(
            'invalid_remote_result',
            'Remote tool returned an invalid MCP result',
            502,
          );
        if (
          !parsed.data.isError &&
          validateOutput &&
          !validateOutput(parsed.data.structuredContent)
        ) {
          throw new MervError(
            'invalid_remote_result',
            'Remote structured content failed its declared output schema',
            502,
          );
        }
        // Validate without returning the SDK's parsed copy: parsing may strip extension metadata.
        return { format: 'mcp', value: result };
      },
    };
  }

  register(definition: AnyToolDefinition): () => Promise<void> {
    this.open();
    if (isRemoteTool(definition))
      throw new MervError(
        'catalog_required',
        'Remote MCP tools must be registered through createCatalog',
      );
    if (!definition || typeof definition.name !== 'string')
      throw new MervError('invalid_tool', 'Tool name is required');
    if (isMountedToolName(definition.name))
      throw new MervError('reserved_namespace', 'Mounted tool namespaces are owned by catalogs');
    if (this.entries.has(definition.name))
      throw new MervError('duplicate_tool', `Tool already registered: ${definition.name}`, 409);
    const entry = this.prepare(definition);
    this.entries.set(entry.name, entry);
    return async () => {
      if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name);
      await this.drain([entry]);
    };
  }

  createCatalog(mountId: string): ToolCatalog {
    this.open();
    if (typeof mountId !== 'string' || !mountPattern.test(mountId))
      throw new MervError(
        'invalid_mount',
        'Mount ID must contain 1–64 lowercase letters, digits or hyphens, beginning with a letter or digit',
      );
    if (this.catalogs.has(mountId))
      throw new MervError('duplicate_mount', `Mount already registered: ${mountId}`, 409);
    const catalog: CatalogState = { active: true, current: new Set(), owned: new Set() };
    this.catalogs.set(mountId, catalog);
    let disposing: Promise<void> | undefined;
    return {
      replace: async (definitions) => {
        this.open();
        if (!catalog.active)
          throw new MervError('catalog_closed', 'Remote catalog is disposed', 409);
        if (!Array.isArray(definitions))
          throw new MervError('invalid_tool', 'Catalog definitions must be an array');
        const candidate = new Map<string, Entry>();
        for (const definition of definitions) {
          if (
            !definition ||
            !isRemoteTool(definition) ||
            typeof definition.name !== 'string' ||
            !namePattern.test(definition.name)
          )
            throw new MervError('invalid_tool', 'Catalog entries must be named MCP tools');
          const name = `${namespace}${mountId}.${definition.name}`;
          if (candidate.has(name))
            throw new MervError('duplicate_tool', `Duplicate remote tool: ${definition.name}`, 409);
          const current = this.entries.get(name);
          if (current && !catalog.current.has(current))
            throw new MervError('duplicate_tool', `Tool already registered: ${name}`, 409);
          candidate.set(
            name,
            this.prepare({ ...definition, name }, { mountId, toolName: definition.name }),
          );
        }
        this.open();
        if (!catalog.active)
          throw new MervError('catalog_closed', 'Remote catalog is disposed', 409);
        const previous = [...catalog.current];
        // No awaits between withdrawing the old generation and publishing the complete new one.
        for (const entry of previous)
          if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name);
        catalog.current = new Set(candidate.values());
        for (const entry of catalog.current) {
          this.entries.set(entry.name, entry);
          catalog.owned.add(entry);
        }
        await this.drain(previous);
        for (const entry of previous) catalog.owned.delete(entry);
      },
      dispose: () =>
        (disposing ??= (async () => {
          catalog.active = false;
          if (this.catalogs.get(mountId) === catalog) this.catalogs.delete(mountId);
          const owned = [...catalog.owned];
          for (const entry of owned)
            if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name);
          catalog.current.clear();
          await this.drain(owned);
          catalog.owned.clear();
        })()),
    };
  }

  registerSessionPolicy(provider: SessionToolPolicy): () => void {
    if (this.sessions)
      throw new MervError('session_provider_conflict', 'Session policy is already registered', 409);
    const registration = { provider };
    this.sessions = registration;
    return () => {
      if (this.sessions === registration) this.sessions = undefined;
    };
  }

  registerConversationPolicy(provider: ConversationToolPolicy): () => void {
    if (this.conversations)
      throw new MervError(
        'conversation_provider_conflict',
        'Conversation policy is already registered',
        409,
      );
    const registration = { provider };
    this.conversations = registration;
    return () => {
      if (this.conversations === registration) this.conversations = undefined;
    };
  }

  private conversationPolicy(): ConversationRegistration {
    if (!this.conversations)
      throw new MervError('conversation_unavailable', 'Conversation policy is unavailable', 503);
    return this.conversations;
  }

  private requireConversationCaller(caller: Caller): void {
    if (
      caller.conversation &&
      (caller.session ||
        caller.managed ||
        caller.human ||
        caller.key ||
        caller.credentialId !== undefined)
    )
      throw new MervError('forbidden', 'A conversation cannot combine authorities', 403);
  }

  private fenceConversation(registration: ConversationRegistration): void {
    if (this.conversations !== registration)
      throw new MervError(
        'conversation_unavailable',
        'Conversation policy changed during authorization',
        503,
      );
  }

  private async conversationDecision<T>(
    registration: ConversationRegistration,
    decision: Promise<T>,
  ): Promise<T> {
    const result = await decision;
    this.fenceConversation(registration);
    return result;
  }

  private async admitConversation(
    registration: ConversationRegistration,
    caller: Caller,
    entry: Entry,
    input: Data,
  ): Promise<void> {
    this.fenceConversation(registration);
    if (
      !this.reads(entry) ||
      !(await this.conversationDecision(
        registration,
        registration.provider.allowsTool(caller, entry.name),
      ))
    )
      throw new MervError('tool_forbidden', 'Conversation tool is not admitted', 403);
    await this.conversationDecision(
      registration,
      registration.provider.validate(caller, entry.name, input),
    );
  }

  private sessionPolicy(): SessionRegistration {
    if (!this.sessions)
      throw new MervError('session_unavailable', 'Session policy is unavailable', 503);
    return this.sessions;
  }

  /** Checked after every provider await: a withdrawn or replaced provider cannot finish a decision. */
  private fence(registration: SessionRegistration): void {
    if (this.sessions !== registration)
      throw new MervError(
        'session_unavailable',
        'Session policy changed during authorization; retry with the current provider',
        503,
      );
  }

  private async fenced<T>(registration: SessionRegistration, decision: Promise<T>): Promise<T> {
    const value = await decision;
    this.fence(registration);
    return value;
  }

  async validateSession(caller: Caller, name: string, input: Data): Promise<void> {
    const session = this.sessionPolicy();
    await this.fenced(session, session.provider.validate(caller, name, input));
  }

  /** A native tool that only reads; a session may call every one of them. */
  private reads(entry: Entry): boolean {
    // Like the compiled schema, authority belongs to the published registration. Native
    // handlers may be instrumented, but mutating their definition must not change policy.
    return !entry.remote && entry.description.annotations?.readOnlyHint === true;
  }

  private async visible(caller?: Caller): Promise<Entry[]> {
    if (caller) caller = structuredClone(caller);
    if (caller) this.requireConversationCaller(caller);
    const conversation = caller?.conversation ? this.conversationPolicy() : undefined;
    if (caller) await this.scope.require(caller, 'read');
    if (conversation) this.fenceConversation(conversation);
    const session = caller?.session ? this.sessionPolicy() : undefined;
    const visible = await filterAsync(
      [...this.entries.values()],
      async (entry) =>
        (!conversation ||
          (this.reads(entry) &&
            (await this.conversationDecision(
              conversation,
              conversation.provider.allowsTool(caller!, entry.name),
            )))) &&
        (!caller ||
          !session ||
          (await this.fenced(
            session,
            session.provider.allowsTool(caller, entry.name, this.reads(entry)),
          ))) &&
        (!caller ||
          !entry.remote ||
          (await this.access?.allows(caller, entry.remote.mountId, entry.remote.toolName)) ===
            true),
    );
    if (conversation) {
      await this.scope.require(caller!, 'read');
      this.fenceConversation(conversation);
    }
    return visible;
  }

  async describe(caller?: Caller): Promise<ToolDescription[]> {
    if (caller?.managed)
      throw new MervError('managed_runner_forbidden', 'Managed runners cannot use tools', 403);
    return (await this.visible(caller))
      .map((entry) => structuredClone(entry.description))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(caller?: Caller): Promise<AnyToolDefinition[]> {
    if (caller?.managed)
      throw new MervError('managed_runner_forbidden', 'Managed runners cannot use tools', 403);
    return (await this.visible(caller))
      .map(({ definition, description }) =>
        isRemoteTool(definition)
          ? { ...structuredClone(description), kind: 'mcp' as const, handler: definition.handler }
          : definition,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async invoke(name: string, caller: Caller, input: unknown): Promise<ToolInvocation> {
    this.open();
    caller = structuredClone(caller);
    this.requireConversationCaller(caller);
    if (caller.managed)
      throw new MervError('managed_runner_forbidden', 'Managed runners cannot use tools', 403);
    const conversation = caller.conversation ? this.conversationPolicy() : undefined;
    const entry = this.entries.get(name);
    if (!entry) throw new MervError('unknown_tool', `Unknown tool: ${name}`, 404);
    if (conversation && !this.reads(entry))
      throw new MervError(
        'tool_forbidden',
        'Conversations may only invoke native read-only tools',
        403,
      );
    input = plain(input);
    // Admission owns the entire operation, including asynchronous authentication and parsing.
    const operation = Promise.resolve().then(async () => {
      // A session caller is authorized by its admission in prepare, below.
      if (!caller.session) await this.scope.require(caller, 'read');
      if (conversation) this.fenceConversation(conversation);
      if (entry.remote) {
        if (!this.access)
          throw new MervError(
            'tool_forbidden',
            'Remote tools require an explicit access policy',
            403,
          );
        await this.access.require(caller, entry.remote.mountId, entry.remote.toolName);
      }
      const session = caller.session ? this.sessionPolicy() : undefined;
      const prepared = await session?.provider.prepare(
        caller,
        name,
        input as Data,
        this.reads(entry),
      );
      // Preparation may allocate a reservation. Its original provider releases it in finally,
      // even when a replacement now owns the slot.
      try {
        if (session) this.fence(session);
        const dispatchCaller = prepared?.caller ?? caller;
        const parsed = await entry.parse(prepared ? prepared.input : input);
        const validate = async (caller: Caller) => {
          if (session)
            await this.fenced(session, session.provider.validate(caller, name, parsed as Data));
          if (conversation)
            await this.admitConversation(conversation, caller, entry, parsed as Data);
        };
        await validate(dispatchCaller);
        let completed: ToolInvocation | undefined;
        const dispatch = async (activeCaller: Caller) => {
          // The provider's run validates a session again right before this handler.
          if (!prepared) await this.scope.require(activeCaller, 'read');
          if (conversation) this.fenceConversation(conversation);
          if (entry.remote)
            await this.access!.require(activeCaller, entry.remote.mountId, entry.remote.toolName);
          const run = async () => {
            if (conversation) {
              await this.scope.require(activeCaller, 'read');
              this.fenceConversation(conversation);
              await validate(activeCaller);
            }
            return await entry.definition.handler(activeCaller, parsed);
          };
          const result =
            this.readScope && this.reads(entry) ? await this.readScope(run) : await run();
          // Read handlers can wait for external storage while their PostgreSQL snapshot
          // retains old permissions. Reauthorize after releasing that snapshot, before
          // handing any bytes or signed URL to the caller. Mutations keep their own
          // transactional authorization and may legitimately end their worker session.
          if (this.reads(entry)) {
            await this.scope.require(activeCaller, 'read');
            await validate(activeCaller);
            if (conversation) this.fenceConversation(conversation);
          }
          completed = entry.complete(result);
          return result;
        };
        const result =
          session && prepared
            ? await session.provider.run(prepared, (activeCaller) => {
                // Provider admission may itself await storage. Check once more at dispatch,
                // but do not turn an already committed mutation into an error afterward.
                this.fence(session);
                return dispatch(activeCaller);
              })
            : await dispatch(caller);
        return completed ?? entry.complete(result);
      } finally {
        if (session && prepared) await session.provider.cancel(prepared);
      }
    });
    entry.running.add(operation);
    this.running.add(operation);
    try {
      return await operation;
    } finally {
      entry.running.delete(operation);
      this.running.delete(operation);
    }
  }

  async call(name: string, caller: Caller, input: unknown): Promise<unknown> {
    return (await this.invoke(name, caller, input)).value;
  }

  private async drain(entries: Entry[]): Promise<void> {
    await Promise.allSettled(entries.flatMap((entry) => [...entry.running]));
  }

  /** Stop admission immediately; wait for every admitted generation, including replaced catalogs. */
  async close(): Promise<void> {
    this.stopping = true;
    this.entries.clear();
    for (const catalog of this.catalogs.values()) catalog.active = false;
    this.catalogs.clear();
    await Promise.allSettled([...this.running]);
  }
}
