import type { View } from '@merv/contracts/board-view';
import {
  check,
  ellipsis,
  MervError,
  plain,
  record,
  toolNamePattern,
  type Caller,
  type Data,
  type Scope,
} from '@merv/contracts';
import type { SessionToolPolicy, ToolPolicy } from '@merv/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { noun, nounActions, presented } from './noun.js';
import {
  CallToolResultSchema,
  ToolSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentToolCall,
  AnyToolDefinition,
  CallerKind,
  CallerRules,
  ListedTool,
  NounDefinition,
  Picture,
  PictureDrawer,
  RegisteredTool,
  RemoteToolDefinition,
  ToolAdmission,
  ToolAlias,
  ToolCatalog,
  ToolDescription,
  ToolDefinition,
  ToolIdentity,
  ToolInvocation,
  ToolTier,
  Tools,
} from './types.js';
import type { ValidateFunction } from 'ajv';
import { cloneJson, compileSchema } from './schema.js';
import { toolsGuide } from './guide.js';
import { validated } from './errors.js';

export function isRemoteTool<T extends AnyToolDefinition | ListedTool>(
  tool: T,
): tool is Extract<T, { kind: 'mcp' }> {
  return !!tool && typeof tool === 'object' && 'kind' in tool && tool.kind === 'mcp';
}

/** These schemas constrain the same arguments; properties/$defs constrain nested values instead. */
function inputBranches(
  schema: Record<string, unknown>,
  visit: (schema: Record<string, unknown>) => void,
): void {
  visit(schema);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const branches = schema[key];
    if (Array.isArray(branches))
      for (const branch of branches) if (record(branch)) inputBranches(branch, visit);
  }
  for (const key of ['if', 'then', 'else', 'not']) {
    const branch = record(schema[key]);
    if (branch) inputBranches(branch, visit);
  }
}

/** Canonical public metadata; project selection is a transport envelope, not handler input. A core
 *  tool carries `_meta["anthropic/alwaysLoad"]`, which Claude Code reads (other clients ignore it). */
export function describeTool(tool: AnyToolDefinition): ToolDescription {
  if (isRemoteTool(tool)) {
    const { handler: _handler, kind: _kind, ...description } = tool;
    return structuredClone(description);
  }
  const schema =
    tool.inputJsonSchema === undefined
      ? zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none', target: 'jsonSchema7' })
      : cloneJson(tool.inputJsonSchema);
  if (!record(schema) || !('type' in schema) || schema.type !== 'object')
    throw new MervError('invalid_tool', 'Tool input must be an object');
  // Transports take projectId out of a native tool's arguments to select the project.
  if (tool.inputJsonSchema !== undefined) compileSchema(schema);
  const prepareBranch = (branch: Record<string, unknown>) => {
    if (tool.inputJsonSchema !== undefined) {
      for (const key of [
        '$ref',
        '$dynamicRef',
        '$recursiveRef',
        'propertyNames',
        'patternProperties',
        'minProperties',
        'maxProperties',
        'dependencies',
        'dependentRequired',
        'dependentSchemas',
        'const',
        'enum',
      ])
        if (key in branch)
          throw new MervError(
            'invalid_schema',
            `Native tool object branches cannot use ${key}: projectId is a transport field`,
          );
      if (Array.isArray(branch.required) && branch.required.includes('projectId'))
        throw new MervError('invalid_tool', 'projectId is reserved for project selection');
    }
    const properties = record(branch.properties) ?? {};
    if (Object.hasOwn(properties, 'projectId'))
      throw new MervError('invalid_tool', 'projectId is reserved for project selection');
    // A closed action branch must admit the transport envelope too. Keep its type at the root.
    if ('additionalProperties' in branch || 'unevaluatedProperties' in branch)
      branch.properties = { ...properties, projectId: {} };
  };
  if (tool.inputJsonSchema === undefined) prepareBranch(schema);
  else inputBranches(schema, prepareBranch);
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
    // A write carries MCP's default destructiveHint, which a client's own prompt reads. A noun
    // tool's requestId lives inside each action's object, so it claims no idempotence.
    annotations: {
      ...(tool.act && { title: tool.act.title }),
      readOnlyHint: tool.readOnly ?? false,
      ...('properties' in schema &&
        Object.hasOwn(schema.properties ?? {}, 'requestId') && {
          idempotentHint: true,
        }),
      openWorldHint: tool.openWorld ?? false,
    },
    ...(tool.tier === 'core' && { _meta: { 'anthropic/alwaysLoad': true } }),
  };
}

/** The vendored Sandboxes host still marks its page-only tools `conversation: 'never'`. */
const legacyTier = (definition: ToolDefinition): ToolTier =>
  definition.conversationProfile
    ? 'worker'
    : (definition as { conversation?: unknown }).conversation === 'never'
      ? 'ui'
      : 'deferred';

interface Entry {
  name: string;
  definition: AnyToolDefinition;
  description: ToolDescription;
  /** Legacy aliases project the original Zod metadata, before action conditions were added. */
  aliasInput?: ToolDefinition['inputSchema'];
  parse(input: unknown): unknown;
  complete(value: unknown, input: unknown): ToolInvocation;
  /** Whether this parsed call reads on a snapshot: a read that stays inside Merv (a noun tool's,
   *  by its action), as decided by the tool a retired name became. A call to a service outside
   *  Merv would hold a reader connection for as long as that service takes to answer. */
  snapshot(input: unknown): boolean;
  running: Set<Promise<ToolInvocation>>;
  remote?: { mountId: string; toolName: string };
  /** What caller rules see, fixed at registration. */
  tool: RegisteredTool;
  /** A retired name: the action it runs, and how its old arguments become that tool's input
   *  (nested: under the action's key, as a noun tool takes them). */
  alias?: { tool: string; action: string; nested: boolean; wrap(input: unknown): unknown };
  /** A kept name's old flat input and text, which a leased session is listed. */
  flat?: ToolDescription;
}
type Retired = ToolAlias & { gone?: true };
/** A remote tool's catalog identity, and how its catalog compiles a schema. */
type Remote = NonNullable<Entry['remote']> & { compile(schema: unknown): ValidateFunction };
interface CatalogState {
  active: boolean;
  current: Set<Entry>;
  owned: Set<Entry>;
}
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const mountPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const namespace = '_';
/** Identity, not provider: re-registering the same provider still retires calls it began. */
type SessionRegistration = { provider: SessionToolPolicy };

/** Reserved even while a catalog is absent, so remote arguments keep their meaning. */
export const isMountedToolName = (name: string): boolean => name.startsWith(namespace);

/** Registrations own admission and draining; remote catalogs swap as one validated generation. */
export class ToolRegistry implements Tools {
  private readonly entries = new Map<string, Entry>();
  /** Noun actions' retired names, and names with no executable path (gone), by what remains. */
  private readonly retired = new Map<string, Retired>();
  /** Plugins' retired names (Tools.alias), resolved when called or named. */
  private readonly resolvers = new Set<(name: string) => ToolAlias | undefined>();
  /** Each retired name's entry, by the registration of the tool it became. */
  private readonly derived = new WeakMap<Entry, Map<string, Entry>>();
  /** For one release every caller runs a retired name; then only a leased session does, until the
   *  published versions that grant those names drain, and every other caller is told the noun. */
  aliasesOpen = true;
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
    /** Keeps one row per outside agent's call (agent_tool_calls), while a state store is there to
     *  keep it; it must not throw. */
    public log?: (call: AgentToolCall) => void,
  ) {}

  private open(): void {
    if (this.stopping) throw new MervError('unavailable', 'Tool registry is stopping', 503);
  }

  private prepare(definition: AnyToolDefinition, remote?: Remote): Entry {
    if (!toolNamePattern.test(definition.name))
      throw new MervError('invalid_tool', `Invalid tool name: ${definition.name}`);
    if (typeof definition.handler !== 'function')
      throw new MervError('invalid_tool', 'Tool handler is required');
    if (isRemoteTool(definition)) {
      if (!remote)
        throw new MervError('catalog_required', 'Remote tools require a catalog identity');
      return this.prepareRemote(definition, remote);
    }
    // Schema changes require a new registration, keeping validation paired with its catalog.
    // Tier and whether it only reads (which a session may call, as may a platform reader) are
    // likewise the registration's: mutating the definition changes none of them.
    const { inputSchema, conversationProfile, actions, reads, legacy } = definition;
    const readOnly = definition.readOnly === true;
    // A Pi profile's own tool answers only that profile's conversation, so no worker is listed it.
    const worker = conversationProfile ? 'never' : definition.worker;
    const tier = conversationProfile ? 'worker' : (definition.tier ?? legacyTier(definition));
    // Whether a call reaches outside Merv is the registration's too: a noun tool's, per action.
    const openWorld = definition.openWorld === true;
    const outside = new Set(
      Object.entries(actions ?? {}).flatMap(([name, action]) => (action.openWorld ? [name] : [])),
    );
    return {
      name: definition.name,
      definition,
      description: describeTool({ ...definition, inputSchema, readOnly, tier }),
      ...(definition.inputJsonSchema !== undefined && {
        aliasInput: inputSchema,
      }),
      ...(legacy && {
        flat: describeTool({ ...definition, ...legacy, inputSchema: legacy.input, tier: 'worker' }),
      }),
      tool: {
        name: definition.name,
        remote: false,
        readOnly,
        worker,
        tier,
        ...(actions && { actions: nounActions(actions) }),
        ...(definition.for && { for: definition.for }),
        ...(conversationProfile && { conversationProfile }),
        ...(reads && { reads }),
      },
      parse: async (input) =>
        validated(await inputSchema.safeParseAsync(input), 'Tool input failed validation'),
      complete: (value, input) =>
        definition.present
          ? { format: 'json', value, mcp: definition.present(value, input) }
          : { format: 'json', value },
      snapshot: (input) =>
        readOnly && !(actions ? outside.has((input as { action: string }).action) : openWorld),
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
      tool: { name: definition.name, remote: true, readOnly: false, tier: 'deferred' },
      snapshot: () => false,
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
    const entry = this.prepare(definition);
    const { actions = {}, removed = {} } = definition;
    // Its actions' retired names run as them; a removed name only says what remains.
    const retired: [string, Retired][] = [
      ...Object.entries(actions).flatMap(([action, { was = [] }]) =>
        was.map((name) => [name, { tool: entry.name, action }] as [string, Retired]),
      ),
      ...Object.entries(removed).map(
        ([name, action]) => [name, { tool: entry.name, action, gone: true }] as [string, Retired],
      ),
    ];
    for (const name of [entry.name, ...retired.map(([name]) => name)])
      if (this.entries.has(name) || this.retired.has(name))
        throw new MervError('duplicate_tool', `Tool already registered: ${name}`, 409);
    for (const [name, { action }] of retired)
      if (!Object.hasOwn(actions, action))
        throw new MervError('invalid_tool', `${name} names no action of ${entry.name}`);
    this.entries.set(entry.name, entry);
    for (const [name, alias] of retired) this.retired.set(name, alias);
    return async () => {
      if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name);
      for (const [name, alias] of retired)
        if (this.retired.get(name) === alias) this.retired.delete(name);
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

  alias(resolve: (name: string) => ToolAlias | undefined): () => void {
    this.resolvers.add(resolve);
    return () => void this.resolvers.delete(resolve);
  }

  /** The entry a name runs: its own, else the tool a retired name became (a noun action's own
   *  retired name, or one a plugin resolves). */
  private entry(name: string): Entry | undefined {
    const own = this.entries.get(name);
    if (own) return own;
    const named = this.retired.get(name);
    const found: (Retired | undefined)[] = named
      ? [named]
      : [...this.resolvers].map((resolve) => resolve(name));
    for (const alias of found) {
      const target = alias && !alias.gone && this.entries.get(alias.tool);
      if (!target || target.remote) continue;
      let derived = this.derived.get(target);
      if (!derived) this.derived.set(target, (derived = new Map()));
      const entry = derived.get(name) ?? this.derive(name, alias, target);
      derived.set(name, entry);
      return entry;
    }
  }

  /** A retired name run as the tool it became: only the old tool's arguments, as it took them;
   *  whether its action reads; a noun action's own text. It shares that tool's handler,
   *  admission, snapshots and draining. */
  private derive(name: string, { action, args }: ToolAlias, target: Entry): Entry {
    const definition = target.definition as ToolDefinition;
    const nested = definition.actions?.[action];
    // Its action decides whether it reads, so sessions, readers and scripts judge the old tool.
    const readOnly = target.tool.readOnly || !!target.tool.reads?.({ action });
    let wrap = (input: unknown): unknown => ({ action, [action]: input });
    let parse = async (input: unknown) =>
      wrap(validated(await nested!.input.safeParseAsync(input), 'Tool input failed validation'));
    let description: ToolDescription;
    if (nested) {
      // Its own text and flat arguments, as a leased worker was listed the old tool.
      description = describeTool({
        name,
        description: nested.description,
        inputSchema: nested.input,
        readOnly,
        ...(nested.openWorld && { openWorld: true }),
        handler: definition.handler,
      });
    } else {
      // Only the old tool's arguments, then their new names: no caller's key meets a renamed one.
      const takes = (key: string) => (args ? Object.hasOwn(args, key) : key !== 'action');
      const to = (key: string) => (args && Object.hasOwn(args, key) ? args[key]! : key);
      wrap = (input, fields = record(input)) =>
        fields
          ? { ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [to(k), v])), action }
          : input;
      parse = async (input) => {
        const extra = Object.keys(record(input) ?? {}).find((key) => !takes(key));
        check(
          extra === undefined,
          'invalid_input',
          `${name} takes no ${ellipsis(`${extra}`, 100)}`,
        );
        return await target.parse(wrap(input));
      };
      // Its old arguments, typed as the tool it became takes them.
      const { annotations } = target.description;
      const inputSchema = target.aliasInput
        ? describeTool({
            ...(target.definition as ToolDefinition),
            inputSchema: target.aliasInput,
            inputJsonSchema: undefined,
          }).inputSchema
        : target.description.inputSchema;
      const { properties = {}, required = [], ...schema } = inputSchema;
      const keys = args
        ? [...Object.keys(args), 'projectId']
        : Object.keys(properties).filter(takes);
      const needs = keys.filter((key) => required.includes(to(key)));
      description = {
        ...target.description,
        name,
        inputSchema: {
          ...schema,
          properties: Object.fromEntries(keys.map((key) => [key, properties[to(key)]])),
          ...(needs.length && { required: needs }),
        },
        annotations: { ...annotations, readOnlyHint: readOnly },
      };
    }
    const { tier } = target.tool;
    return {
      ...target,
      name,
      definition: { ...definition, name, readOnly, reads: undefined },
      description,
      // Never loaded up front, and a noun's listed to leased workers as the old tool was.
      tool: {
        ...target.tool,
        name,
        readOnly,
        reads: undefined,
        tier: tier === 'core' ? 'deferred' : tier,
        actions: undefined,
        // A noun for people or conversations alone was never a worker's, nor were its names.
        worker: nested && !target.tool.for ? undefined : target.tool.worker,
      },
      parse,
      alias: { tool: target.name, action, nested: !!nested, wrap },
      flat: undefined,
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

  private readonly drawers = new Map<string, PictureDrawer>();
  contributePicture(prefix: string, draw: PictureDrawer): () => void {
    if (this.drawers.has(prefix))
      throw new MervError('picture_conflict', `Records ${prefix}… already have a drawer`, 409);
    this.drawers.set(prefix, draw);
    return () => {
      if (this.drawers.get(prefix) === draw) this.drawers.delete(prefix);
    };
  }

  async picture(
    caller: Caller,
    id: string,
    focus?: string,
    view?: View,
  ): Promise<Picture | undefined> {
    const draw = [...this.drawers].find(([prefix]) => id.startsWith(prefix))?.[1];
    return draw ? await draw(structuredClone(caller), id, focus, view) : undefined;
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
    // Each kind is named by the caller field that carries its authority.
    const kind = (['conversation', 'managed', 'platform'] as const).find((name) => caller?.[name]);
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

  /** What MCP offers a person's agent (see Tools.describe): tiers core and deferred, never a
   *  retired name. It curates; it does not authorize. */
  private offered(entry: Entry, reader: boolean): boolean {
    const { tool } = entry;
    const reads = tool.readOnly || !!tool.reads;
    return (
      !!entry.remote ||
      (!entry.alias &&
        (tool.tier === 'core' || tool.tier === 'deferred') &&
        tool.for !== 'conversations' &&
        (!reader || reads))
    );
  }

  /** names: retired names to list too, as the tools they became (a profile naming one). */
  private async visible(
    caller?: Caller,
    agent = false,
    names?: readonly string[],
  ): Promise<Entry[]> {
    if (caller) caller = structuredClone(caller);
    const rules = this.rulesFor(caller);
    // Scope refuses a conversation that also carries another authority.
    const actor = caller ? await this.scope.require(caller, 'read') : undefined;
    const reader = actor?.role === 'reader';
    const session = caller?.session ? this.sessionPolicy() : undefined;
    // A noun action's retired name is listed to a leased session, as the old tool was; any
    // retired name to whoever names it.
    const retired = [...new Set([...(session ? this.retired.keys() : []), ...(names ?? [])])];
    const offered = [
      ...this.entries.values(),
      ...retired.flatMap((name) => (this.entries.has(name) ? [] : (this.entry(name) ?? []))),
    ].filter(
      (entry) => (!agent || this.offered(entry, reader)) && (!rules || rules.offers!(entry.tool)),
    );
    // One grant decision covers every mounted tool still in the listing.
    const grant =
      caller && this.access && offered.some((entry) => entry.remote)
        ? await this.access.granted(caller)
        : undefined;
    const shown: Entry[] = [];
    for (const entry of offered)
      if (
        (!session ||
          (entry.tool.worker !== 'never' &&
            entry.tool.for !== 'people' &&
            (await this.fenced(
              session,
              // A tool some of whose actions read is listed as one that reads.
              session.provider.allowsTool(
                caller!,
                entry.name,
                entry.tool.readOnly || !!entry.tool.reads,
              ),
            )))) &&
        (!caller || !entry.remote || grant?.(entry.remote.mountId, entry.remote.toolName) === true)
      )
        shown.push(entry);
    return shown.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** agent: a person's own agent over MCP, never a leased worker. */
  async describe(
    caller?: Caller,
    agent = false,
    { projectless = false, names }: { projectless?: boolean; names?: readonly string[] } = {},
  ): Promise<ToolDescription[]> {
    const renamed = caller?.session ? undefined : this.renaming();
    const entries = await this.visible(caller, agent && !caller?.session, names);
    return entries
      .filter((entry) => !projectless || !entry.remote)
      .map((entry) => {
        // A retired name's text is written as its leased workers know it; everyone else, who is
        // listed the noun tools instead, reads each such name as the noun action it now runs.
        const description = structuredClone((caller?.session && entry.flat) || entry.description);
        if (renamed && !entry.remote) renamed(description);
        // A session's project is fixed by its lease, so a native tool is listed to it without the
        // projectId people choose one with, which every tool would otherwise repeat.
        if (caller?.session && !entry.remote)
          inputBranches(description.inputSchema, (branch) => {
            const properties = record(branch.properties);
            if (properties) delete properties.projectId;
          });
        return description;
      });
  }

  /** Rewrites, in place, each description text (never a name, key or schema value) naming a
   *  retired name with an executable path as what it now reads as: `code.status` is
   *  `code.read status`. */
  private renaming() {
    const to = new Map(
      [...this.retired].flatMap(([name, { tool, action, gone }]) =>
        gone ? [] : [[name, `${tool} ${action}`] as const],
      ),
    );
    if (!to.size) return undefined;
    const names = [...to.keys()]
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replaceAll('.', '\\.'));
    const pattern = new RegExp(`(?<![\\w.])(?:${names.join('|')})(?!\\w|\\.\\w)`, 'g');
    const rewrite = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const object = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(object))
        if (key === 'description' && typeof value === 'string')
          object[key] = value.replace(pattern, (name) => to.get(name)!);
        else rewrite(value);
    };
    return rewrite;
  }

  async list(names?: readonly string[]): Promise<ListedTool[]> {
    return (await this.visible(undefined, false, names)).map(({ definition, description }) =>
      isRemoteTool(definition)
        ? { ...structuredClone(description), kind: 'mcp' as const }
        : definition,
    );
  }

  noun(name: string, definition: NounDefinition): () => Promise<void> {
    return this.register(noun(name, definition));
  }

  tool(name: string): RegisteredTool | undefined {
    const entry = this.entry(name);
    return entry && { ...entry.tool };
  }

  /** The entry an address or name runs, with the input it takes there: an address `tool:action`
   *  wraps its flat arguments into the noun's form. */
  private resolve(name: string, input: unknown): { entry?: Entry; input: unknown } {
    const colon = name.indexOf(':');
    if (colon < 0) return { entry: this.entry(name), input };
    const [tool, action] = [name.slice(0, colon), name.slice(colon + 1)];
    const entry = this.entries.get(tool);
    if (!(entry?.definition as ToolDefinition | undefined)?.actions) return { input };
    return { entry, input: { action, [action]: input } };
  }

  guidance<T>(caller: Caller, value: T): T {
    return presented(this, caller, value);
  }

  identity(name: string, input: unknown): ToolIdentity | undefined {
    const resolved = this.resolve(name, input);
    return resolved.entry && this.identify(resolved.entry, resolved.input);
  }

  private identify({ name, alias, definition }: Entry, input: unknown): ToolIdentity {
    const args = (value: unknown) => (record(value) ?? {}) as Data;
    if (alias) return { tool: alias.tool, action: alias.action, as: name, args: args(input) };
    const actions = (definition as ToolDefinition).actions ?? {};
    const action = record(input)?.action;
    if (typeof action !== 'string' || !Object.hasOwn(actions, action))
      return { tool: name, as: name, args: args(input) };
    const as = actions[action]!.was?.[0] ?? name;
    return { tool: name, action, as, args: args(record(input)![action]) };
  }

  /** What a retired name's caller is told once it no longer runs, with its input as that tool
   *  takes it. */
  private renamed(name: string, target: ToolAlias, call?: unknown) {
    return new MervError(
      'tool_renamed',
      call
        ? `${name} is now ${target.tool} with action ${target.action}: ${ellipsis(JSON.stringify(call), 300)}`
        : `${name} was removed; what remains is ${target.tool} with action ${target.action}`,
      404,
      { tool: target.tool, action: target.action, ...(call !== undefined && { arguments: call }) },
    );
  }

  /** agent: as for describe; such a caller cannot run what it is not offered, but a retired name
   *  runs for everyone for one release. `name` may be an address `tool:action`. */
  async invoke(
    name: string,
    caller: Caller,
    input: unknown,
    agent = false,
    admit?: ToolAdmission,
    client?: string,
  ): Promise<ToolInvocation> {
    this.open();
    caller = structuredClone(caller);
    // An outside agent's call is logged with its outcome, however it ends.
    const logged = agent && !caller.session && !caller.conversation && this.log;
    const started = Date.now();
    let identity: ToolIdentity | undefined;
    try {
      const value = await this.run(name, caller, input, agent, admit, (seen) => {
        identity = seen;
      });
      // A mounted tool's own failure is returned, not thrown, and is a failure all the same.
      const failed = (value.format === 'mcp' ? (value.value as CallToolResult) : value.mcp)
        ?.isError;
      if (logged) this.record(caller, name, identity, started, client, failed ? 'tool_error' : '');
      return value;
    } catch (error) {
      const code = error instanceof MervError ? error.code : 'internal_error';
      if (logged) this.record(caller, name, identity, started, client, code);
      throw error;
    }
  }

  private record(
    caller: Caller,
    name: string,
    identity: ToolIdentity | undefined,
    started: number,
    client: string | undefined,
    errorCode: string,
  ): void {
    try {
      this.log?.({
        projectId: caller.projectId,
        actorId: caller.actorId,
        ...(client && { client }),
        // A retired name as called, so that its use after the release stays countable.
        tool: identity && identity.as !== name ? identity.tool : name,
        ...(identity?.action && { action: identity.action }),
        outcome: errorCode ? 'failed' : 'succeeded',
        ...(errorCode && { errorCode }),
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
      });
    } catch {
      // The log never decides a call.
    }
  }

  private async run(
    name: string,
    caller: Caller,
    input: unknown,
    agent: boolean,
    admit: ToolAdmission | undefined,
    seen: (identity: ToolIdentity) => void,
  ): Promise<ToolInvocation> {
    // Scope refuses a conversation that also carries another authority, at its read decision.
    const rules = this.rulesFor(caller);
    const resolved = this.resolve(name, input);
    const entry = resolved.entry;
    input = resolved.input;
    if (!entry) {
      const gone = this.retired.get(name);
      if (gone) throw this.renamed(name, gone);
      throw new MervError('unknown_tool', `Unknown tool: ${ellipsis(name, 200)}`, 404);
    }
    name = entry.name;
    if (entry.alias && !this.aliasesOpen && !caller.session)
      throw this.renamed(name, entry.alias, entry.alias.wrap(input));
    if (rules && !rules.offers!(entry.tool)) throw rules.forbidden;
    // A reader's writes are refused by their own permission check, as over /tools.
    // A retired or kept name is judged by the tool it became: never more than that is offered.
    const became = entry.alias?.tool ?? (entry.definition as ToolDefinition).became;
    const judged = became ? this.entries.get(became) : entry;
    if (agent && !caller.session && (!judged || !this.offered(judged, false)))
      throw new MervError('tool_forbidden', 'This tool is not offered to agents', 403);
    if (entry.remote && !this.access)
      throw new MervError('tool_forbidden', 'Remote tools require an explicit access policy', 403);
    input = plain(input);
    const identity = this.identify(entry, input);
    seen(identity);
    // Admission owns the entire operation, including asynchronous authentication and parsing.
    const operation = Promise.resolve().then(async () => {
      const session = caller.session ? this.sessionPolicy() : undefined;
      // A read of a tool that also writes is admitted as any read is (founder, 2026-09-17: no
      // read constraints); its writes keep the grants exact.
      const { readOnly, reads } = entry.tool;
      const read =
        readOnly ||
        (!!session &&
          !!reads &&
          (await Promise.resolve(input)
            .then(entry.parse)
            .then(reads, () => false)));
      const prepared = await session?.provider.prepare(caller, name, input as Data, read, {
        as: identity.as,
        args: identity.args,
      });
      // Preparation may allocate a reservation. Its original provider releases it in finally,
      // even when a replacement now owns the slot.
      try {
        if (session) this.fence(session);
        const given = prepared ? prepared.input : input;
        const parsed = await entry.parse(given);
        // What the session filled in cannot turn a call admitted as a read into a write.
        check(!read || readOnly || reads!(parsed), 'session_invocation', 'This call writes', 403);
        admit?.(entry.tool, entry.description, parsed);
        // A retired name's arguments are bound as its grant names them.
        const bound = !entry.alias
          ? parsed
          : entry.alias.nested
            ? (parsed as Record<string, unknown>)[entry.alias.action]
            : given;
        if (session && prepared)
          await this.fenced(
            session,
            session.provider.validate(prepared.caller, name, bound as Data),
          );
        let completed: ToolInvocation | undefined;
        // A call's Scope decision is made once, where its tool acts (founder, 2026-10-14): a
        // remote tool's is its grant check right before its handler, which Mounts relies on (a
        // session's also has its admission); a session's native tool's is its admission
        // (prepare); any other native tool's is made right before its handler, inside a read's
        // snapshot so that it decides on the rows the read sees. A read outside a snapshot
        // (open-world, or of a tool that also writes) is decided again after its handler: a
        // revocation while it waited withholds what it brought back (a signed link, an answer).
        const snapshot = entry.snapshot(parsed);
        const dispatch = async (activeCaller: Caller) => {
          if (entry.remote)
            await this.access!.require(activeCaller, entry.remote.mountId, entry.remote.toolName);
          const run = async () => {
            if (!prepared && !entry.remote) await this.scope.require(activeCaller, 'read');
            return await entry.definition.handler(activeCaller, parsed);
          };
          const result = this.readScope && snapshot ? await this.readScope(run) : await run();
          rules?.returns?.(result);
          if ((entry.tool.readOnly || entry.tool.reads?.(parsed)) && !snapshot)
            await this.scope.require(activeCaller, 'read');
          completed = entry.complete(result, parsed);
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
        return completed ?? entry.complete(result, parsed);
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
    this.retired.clear();
    for (const catalog of this.catalogs.values()) catalog.active = false;
    this.catalogs.clear();
    await Promise.allSettled([...this.running]);
  }
}
