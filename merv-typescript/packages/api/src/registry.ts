import { filterAsync, MervError, plain, type Caller, type Data, type Scope } from '@merv/contracts';
import type { SessionToolPolicy, ToolPolicy } from '@merv/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CallToolResultSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  AnyToolDefinition,
  CallerKind,
  CallerRules,
  ListedTool,
  RegisteredTool,
  RemoteToolDefinition,
  ToolDefinition,
  ToolCatalog,
  ToolDescription,
  ToolInvocation,
  Tools,
} from './types.js';
import type { ValidateFunction } from 'ajv';
import { cloneJson, compileSchema } from './schema.js';
import { toolsGuide } from './guide.js';

export type { ToolDescription } from './types.js';
export function isRemoteTool<T extends AnyToolDefinition | ListedTool>(
  tool: T,
): tool is Extract<T, { kind: 'mcp' }> {
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
  // Transports take projectId out of a native tool's arguments to select the project.
  if ('properties' in schema && Object.hasOwn(schema.properties, 'projectId'))
    throw new MervError('invalid_tool', 'projectId is reserved for project selection');
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
    annotations: { readOnlyHint: tool.readOnly ?? false, openWorldHint: tool.openWorld ?? false },
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
  /** What caller rules see, fixed at registration. */
  tool: RegisteredTool;
}
/** A remote tool's catalog identity, and how its catalog compiles a schema. */
type Remote = NonNullable<Entry['remote']> & { compile(schema: unknown): ValidateFunction };
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

/** Reserved even while a catalog is absent, so remote arguments keep their meaning. */
export const isMountedToolName = (name: string): boolean => name.startsWith(namespace);

/** Registrations own admission and draining; remote catalogs swap as one validated generation. */
export class ToolRegistry implements Tools {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<Promise<ToolInvocation>>();
  private readonly catalogs = new Map<string, CatalogState>();
  private sessions?: SessionRegistration;
  private readonly callerRules = new Map<CallerKind, CallerRules>();
  private readonly guide: { text: string }[] = [];
  private readonly readers: { read: (caller: Caller) => Promise<string | undefined> }[] = [];
  private stopping = false;

  constructor(
    private readonly scope: Pick<Scope, 'require'>,
    private readonly access?: Pick<ToolPolicy, 'granted' | 'require'>,
    /** Runs a read-only tool's handler in a snapshot scope: no writer lock, writes refused. */
    private readonly readScope?: <T>(fn: () => Promise<T>) => Promise<T>,
  ) {}

  private open(): void {
    if (this.stopping) throw new MervError('unavailable', 'Tool registry is stopping', 503);
  }

  private prepare(definition: AnyToolDefinition, remote?: Remote): Entry {
    if (!publishedNamePattern.test(definition.name))
      throw new MervError('invalid_tool', `Invalid tool name: ${definition.name}`);
    if (typeof definition.handler !== 'function')
      throw new MervError('invalid_tool', 'Tool handler is required');
    if (isRemoteTool(definition)) {
      if (!remote)
        throw new MervError('catalog_required', 'Remote tools require a catalog identity');
      return this.prepareRemote(definition, remote);
    }
    // Schema changes require a new registration, keeping validation paired with its catalog.
    // Conversation policy is likewise the registration's: mutating the definition changes neither.
    const { inputSchema, conversation } = definition;
    return {
      name: definition.name,
      definition,
      description: describeTool({ ...definition, inputSchema }),
      tool: { name: definition.name, remote: false, conversation },
      async parse(input) {
        const parsed = await inputSchema.safeParseAsync(input);
        if (!parsed.success)
          throw new MervError(
            'invalid_input',
            'Tool input failed validation',
            400,
            parsed.error.issues.map(({ path, message, code }) => ({ path, message, code })),
          );
        return parsed.data;
      },
      complete: (value) => ({ format: 'json', value }),
      running: new Set(),
    };
  }

  private prepareRemote(input: RemoteToolDefinition, { compile, ...remote }: Remote): Entry {
    const { kind: _kind, handler, ...metadata } = input;
    let description: ToolDescription;
    try {
      description = cloneJson(metadata);
    } catch {
      throw new MervError('invalid_tool', 'Remote tool metadata must be JSON');
    }
    if (!ToolSchema.safeParse(description).success)
      throw new MervError('invalid_tool', 'Remote tool description is not valid MCP');
    if (description.execution?.taskSupport && description.execution.taskSupport !== 'forbidden')
      throw new MervError(
        'unsupported_execution',
        'Remote MCP tasks are not supported; taskSupport must be absent or forbidden',
      );
    const validate = compile(description.inputSchema);
    const validateOutput =
      description.outputSchema === undefined ? undefined : compile(description.outputSchema);
    const definition: RemoteToolDefinition = { ...description, kind: 'mcp', handler };
    return {
      name: definition.name,
      definition,
      description,
      remote,
      tool: { name: definition.name, remote: true },
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
        if (!parsed.data.isError && validateOutput?.(parsed.data.structuredContent) === false)
          throw new MervError(
            'invalid_remote_result',
            'Remote structured content failed its declared output schema',
            502,
          );
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
    // The published generation's validators by schema, so an unchanged refresh compiles
    // nothing. Each catalog keeps its own; one validator never serves another catalog.
    let validators = new Map<string, ValidateFunction>();
    return {
      replace: async (definitions) => {
        this.open();
        if (!catalog.active)
          throw new MervError('catalog_closed', 'Remote catalog is disposed', 409);
        if (!Array.isArray(definitions))
          throw new MervError('invalid_tool', 'Catalog definitions must be an array');
        const candidate = new Map<string, Entry>();
        const compiled = new Map<string, ValidateFunction>();
        const compile = (schema: unknown) => {
          const key = JSON.stringify(schema);
          const validate = validators.get(key) ?? compiled.get(key) ?? compileSchema(schema);
          compiled.set(key, validate);
          return validate;
        };
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
          candidate.set(
            name,
            this.prepare({ ...definition, name }, { mountId, toolName: definition.name, compile }),
          );
        }
        const previous = [...catalog.current];
        // No awaits between withdrawing the old generation and publishing the complete new one.
        for (const entry of previous)
          if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name);
        catalog.current = new Set(candidate.values());
        for (const entry of catalog.current) {
          this.entries.set(entry.name, entry);
          catalog.owned.add(entry);
        }
        validators = compiled;
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

  registerCallerRules(kind: CallerKind, rules: CallerRules): () => void {
    if (this.callerRules.has(kind))
      throw new MervError('caller_rules_conflict', `Rules for ${kind} callers are registered`, 409);
    this.callerRules.set(kind, rules);
    return () => {
      if (this.callerRules.get(kind) === rules) this.callerRules.delete(kind);
    };
  }

  contributeInstructions(text: string): () => void {
    const part = { text };
    this.guide.push(part);
    return () => {
      const index = this.guide.indexOf(part);
      if (index >= 0) this.guide.splice(index, 1);
    };
  }

  instructions(): string {
    return [...this.guide.map(({ text }) => text), toolsGuide].join('\n\n');
  }

  contributeContext(read: (caller: Caller) => Promise<string | undefined>): () => void {
    const part = { read };
    this.readers.push(part);
    return () => {
      const index = this.readers.indexOf(part);
      if (index >= 0) this.readers.splice(index, 1);
    };
  }

  async context(caller: Caller): Promise<string> {
    const parts = await Promise.all(
      this.readers.map(({ read }) => read(caller).catch(() => undefined)),
    );
    return parts.filter(Boolean).join('\n\n');
  }

  /** The rules of the plugin that issued this caller, if any; fails closed without them. */
  private rulesFor(caller?: Caller): CallerRules | undefined {
    const kind = caller?.conversation ? 'conversation' : caller?.managed ? 'managed' : undefined;
    if (!kind) return undefined;
    const rules = this.callerRules.get(kind);
    if (!rules) throw new MervError('unavailable', `Tools are unavailable to ${kind} callers`, 503);
    if (!rules.offers) throw rules.forbidden;
    return rules;
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
  /** A read that runs on a snapshot: every one but a call to a service outside Merv, which
   *  would hold a reader connection for as long as that service takes to answer. */
  private snapshotted(entry: Entry): boolean {
    return this.reads(entry) && entry.description.annotations?.openWorldHint !== true;
  }
  /** What MCP offers a person's agent (see Tools.describe); it curates, it does not authorize. */
  private offered(entry: Entry, reader: boolean): boolean {
    return (
      !!entry.remote || (entry.tool.conversation !== 'never' && (!reader || this.reads(entry)))
    );
  }

  private async visible(caller?: Caller, agent = false): Promise<Entry[]> {
    if (caller) caller = structuredClone(caller);
    const rules = this.rulesFor(caller);
    // Scope refuses a conversation that also carries another authority.
    const actor = caller ? await this.scope.require(caller, 'read') : undefined;
    const reader = actor?.role === 'reader';
    const session = caller?.session ? this.sessionPolicy() : undefined;
    const offered = [...this.entries.values()].filter(
      (entry) => (!agent || this.offered(entry, reader)) && (!rules || rules.offers!(entry.tool)),
    );
    // One grant decision covers every mounted tool still in the listing.
    const grant =
      caller && this.access && offered.some((entry) => entry.remote)
        ? await this.access.granted(caller)
        : undefined;
    return await filterAsync(
      offered,
      async (entry) =>
        (!caller ||
          !session ||
          (await this.fenced(
            session,
            session.provider.allowsTool(caller, entry.name, this.reads(entry)),
          ))) &&
        (!caller || !entry.remote || grant?.(entry.remote.mountId, entry.remote.toolName) === true),
    );
  }

  /** agent: a person's own agent over MCP, never a leased worker. */
  async describe(caller?: Caller, agent = false): Promise<ToolDescription[]> {
    return (await this.visible(caller, agent && !caller?.session))
      .map((entry) => structuredClone(entry.description))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(): Promise<ListedTool[]> {
    return (await this.visible())
      .map(({ definition, description }) =>
        isRemoteTool(definition)
          ? { ...structuredClone(description), kind: 'mcp' as const }
          : definition,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** agent: as for describe; such a caller cannot run what it is not offered. */
  async invoke(
    name: string,
    caller: Caller,
    input: unknown,
    agent = false,
  ): Promise<ToolInvocation> {
    this.open();
    caller = structuredClone(caller);
    // Scope refuses a conversation that also carries another authority, at its read decision.
    const rules = this.rulesFor(caller);
    const entry = this.entries.get(name);
    if (!entry) throw new MervError('unknown_tool', `Unknown tool: ${name}`, 404);
    if (rules && !rules.offers!(entry.tool)) throw rules.forbidden;
    // A reader's writes are refused by their own permission check, as over /tools.
    if (agent && !caller.session && !this.offered(entry, false))
      throw new MervError('tool_forbidden', 'This tool is not offered to agents', 403);
    input = plain(input);
    // Admission owns the entire operation, including asynchronous authentication and parsing.
    // A native tool's read decision is made once, right before its handler (dispatch, below); a
    // remote tool's is its grant check (ToolPolicy.require).
    const operation = Promise.resolve().then(async () => {
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
        rules?.admits?.(entry.tool, parsed);
        const validate = async (caller: Caller) => {
          if (session)
            await this.fenced(session, session.provider.validate(caller, name, parsed as Data));
        };
        await validate(dispatchCaller);
        let completed: ToolInvocation | undefined;
        const dispatch = async (activeCaller: Caller) => {
          // The admission immediately before a remote handler: the grant check authorizes
          // through Scope, and Mounts relies on it (a remote tool never runs on a snapshot).
          if (entry.remote)
            await this.access!.require(activeCaller, entry.remote.mountId, entry.remote.toolName);
          const run = async () => {
            // One read decision, inside a read's snapshot when it has one. The provider's run
            // validates a session again right before this handler.
            if (!prepared && !entry.remote) await this.scope.require(activeCaller, 'read');
            return await entry.definition.handler(activeCaller, parsed);
          };
          const result =
            this.readScope && this.snapshotted(entry) ? await this.readScope(run) : await run();
          rules?.returns?.(result);
          // Read handlers can wait for external storage while their PostgreSQL snapshot
          // retains old permissions, and permissions can change while an open-world read
          // waits on another service. Reauthorize after releasing that snapshot, before
          // handing any bytes or signed URL to the caller. Mutations keep their own
          // transactional authorization and may legitimately end their worker session.
          if (this.reads(entry)) {
            await this.scope.require(activeCaller, 'read');
            await validate(activeCaller);
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
