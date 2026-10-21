import { AsyncLocalStorage } from 'node:async_hooks';
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
import { compactTool } from './publication.js';

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

/** Publish tuples as fixed-length arrays for Codex; runtime parsing still checks the tuple. */
function withoutTuples<T>(schema: T): T {
  const node = record(schema);
  if (!node) return Array.isArray(schema) ? (schema.map(withoutTuples) as T) : schema;
  const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, withoutTuples(v)]));
  if (Array.isArray(out.items)) {
    const kinds = [...new Set(out.items.map((item) => JSON.stringify(item)))];
    const count = out.items.length;
    out.items =
      kinds.length === 1 ? out.items[0] : { anyOf: kinds.map((kind) => JSON.parse(kind)) };
    out.minItems ??= count;
    out.maxItems ??= count;
  }
  return out as T;
}

export function describeTool(tool: AnyToolDefinition): ToolDescription {
  if (isRemoteTool(tool)) {
    const { handler: _handler, kind: _kind, ...description } = tool;
    return structuredClone(description);
  }
  const schema =
    tool.inputJsonSchema === undefined
      ? withoutTuples(
          zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none', target: 'jsonSchema7' }),
        )
      : cloneJson(tool.inputJsonSchema);
  if (!record(schema) || !('type' in schema) || schema.type !== 'object')
    throw new MervError('invalid_tool', 'Tool input must be an object');
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
    // Writes retain MCP's destructive default; nested requestIds imply no idempotence.
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
  /** Snapshot only internal reads, by action; remote calls must not hold reader connections. */
  snapshot(input: unknown): boolean;
  running: Set<Promise<ToolInvocation>>;
  remote?: { mountId: string; toolName: string };
  /** What caller rules see, fixed at registration. */
  tool: RegisteredTool;
  /** Retired name mapped to its action; nested aliases wrap arguments under the action key. */
  alias?: { tool: string; action: string; nested: boolean; wrap(input: unknown): unknown };
  /** A kept name's old flat input and text, which a leased session is listed. */
  flat?: ToolDescription;
}
type Retired = ToolAlias & { gone?: true };
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
  private readonly retired = new Map<string, Retired>();
  private readonly resolvers = new Set<(name: string) => ToolAlias | undefined>();
  /** Alias entries belong to the target registration. */
  private readonly derived = new WeakMap<Entry, Map<string, Entry>>();
  /** All callers may use aliases for one release; afterward only leased sessions may. */
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
    /** Outside-agent telemetry; must not throw. */
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
    // Freeze schema, tier and read permissions together at registration.
    const { inputSchema, conversationProfile, actions, reads, legacy } = definition;
    const readOnly = definition.readOnly === true;
    // A Pi profile's own tool answers only that profile's conversation, so no worker is listed it.
    const worker = conversationProfile ? 'never' : definition.worker;
    const tier = conversationProfile ? 'worker' : (definition.tier ?? legacyTier(definition));
    // Freeze open-world status per action too.
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
      ...(legacy && { flat: describeTool({ ...definition, ...legacy, tier: 'worker' }) }),
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
    // Cache validators per catalog generation; unchanged schemas need no recompilation.
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

  /** Resolve registered names before static or plugin-provided aliases. */
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

  /** Aliases retain old input and text, sharing target admission, snapshots and draining. */
  private derive(name: string, { action, args }: ToolAlias, target: Entry): Entry {
    const definition = target.definition as ToolDefinition;
    const nested = definition.actions?.[action];
    const readOnly = target.tool.readOnly || !!target.tool.reads?.({ action });
    let wrap = (input: unknown): unknown => ({ action, [action]: input });
    let parse = async (input: unknown) =>
      wrap(validated(await nested!.input.safeParseAsync(input), 'Tool input failed validation'));
    let description: ToolDescription;
    if (nested) {
      description = describeTool({
        name,
        description: nested.description,
        inputSchema: nested.input,
        readOnly,
        ...(nested.openWorld && { openWorld: true }),
        ...(nested.act && { act: nested.act }),
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
      // Aliases are deferred; leased workers keep their original listing.
      tool: {
        ...target.tool,
        name,
        readOnly,
        reads: undefined,
        tier: tier === 'core' ? 'deferred' : tier,
        actions: undefined,
        // A noun for people or conversations alone was never a worker's, nor were its names.
        worker: nested && !target.tool.for ? undefined : target.tool.worker,
        // A person's action keeps its old names off a leased session's listing too.
        ...(nested?.for && { for: nested.for }),
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

  /** Agent discovery curates tiers and reads; it does not authorize. */
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
    // Sessions see static aliases; profiles may explicitly name any alias.
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

  async describe(
    caller?: Caller,
    agent = false,
    {
      projectless = false,
      names,
      compact = true,
    }: { projectless?: boolean; names?: readonly string[]; compact?: boolean } = {},
  ): Promise<ToolDescription[]> {
    const renamed = caller?.session ? undefined : this.renaming();
    const entries = await this.visible(caller, agent && !caller?.session, names);
    return entries
      .filter((entry) => !projectless || !entry.remote)
      .map((entry) => {
        // Workers keep old descriptions; other callers see noun action names.
        let description = structuredClone((caller?.session && entry.flat) || entry.description);
        if (compact && agent && !caller?.session && !entry.remote)
          description = compactTool(description, entry.definition as ToolDefinition);
        if (renamed && !entry.remote) renamed(description);
        // Session projects are fixed by lease, so omit their project selector.
        if (caller?.session && !entry.remote)
          inputBranches(description.inputSchema, (branch) => {
            const properties = record(branch.properties);
            if (properties) delete properties.projectId;
          });
        return description;
      });
  }

  /** Rewrite executable aliases in descriptions only, never schema keys or values. */
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

  private readonly nouns = new Map<string, { parts: NounDefinition[]; dispose(): Promise<void> }>();

  /** Merge noun contributions on load/unload, requiring distinct actions and matching tiers. */
  noun(name: string, definition: NounDefinition): () => Promise<void> {
    const rebuild = (parts: NounDefinition[]) => {
      const [first] = parts;
      const actions = Object.assign({}, ...parts.map((part) => part.actions));
      check(
        parts.every(({ tier, readOnly }) => tier === first!.tier && readOnly === first!.readOnly) &&
          Object.keys(actions).length === parts.flatMap((part) => Object.keys(part.actions)).length,
        'invalid_tool',
        `${name}'s contributors disagree on its tier or readOnly, or bring an action twice`,
      );
      // Build before withdrawing the old registration; failed contributions change nothing.
      const description = parts.map((part) => part.description).join(' ');
      const summary = parts.map((part) => part.summary ?? part.description).join(' ');
      const built = first && noun(name, { ...first, description, summary, actions });
      const drained = this.nouns.get(name)?.dispose();
      const dispose = built ? this.register(built) : async () => {};
      this.nouns.set(name, { parts, dispose });
      return drained;
    };
    rebuild([...(this.nouns.get(name)?.parts ?? []), definition]);
    return async () =>
      await rebuild(this.nouns.get(name)!.parts.filter((part) => part !== definition));
  }

  tool(name: string): RegisteredTool | undefined {
    const entry = this.entry(name);
    return entry && { ...entry.tool };
  }

  /** Resolve tool:action addresses by nesting their flat arguments. */
  private resolve(name: string, input: unknown): { entry?: Entry; input: unknown } {
    const colon = name.indexOf(':');
    if (colon < 0) return { entry: this.entry(name), input };
    const [tool, action] = [name.slice(0, colon), name.slice(colon + 1)];
    const entry = this.entries.get(tool);
    if (!(entry?.definition as ToolDefinition | undefined)?.actions) return { input };
    return { entry, input: { action, [action]: input } };
  }

  private readonly flatGuidance = new AsyncLocalStorage<boolean>();
  guidance<T>(caller: Caller, value: T, flat = false): T {
    return presented(this, caller, value, flat || !!caller.session || this.flatGuidance.getStore());
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

  /** Agent calls must be offered; aliases stay open for one release. Accept tool:action too. */
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
    const logged = agent && !caller.session && !caller.conversation && this.log;
    const started = Date.now();
    let identity: ToolIdentity | undefined;
    const record = (errorCode: string) => {
      if (!logged) return;
      try {
        this.log?.({
          projectId: caller.projectId,
          actorId: caller.actorId,
          ...(client && { client }),
          tool: identity && identity.as !== name ? identity.tool : name,
          ...(identity?.action && { action: identity.action }),
          outcome: errorCode ? 'failed' : 'succeeded',
          ...(errorCode && { errorCode }),
          startedAt: new Date(started).toISOString(),
          durationMs: Date.now() - started,
        });
      } catch {
        // Telemetry must never decide a call.
      }
    };
    try {
      const value = await this.run(name, caller, input, agent, admit, (seen) => {
        identity = seen;
      });
      // A mounted tool's own failure is returned, not thrown, and is a failure all the same.
      const failed = (value.format === 'mcp' ? (value.value as CallToolResult) : value.mcp)
        ?.isError;
      record(failed ? 'tool_error' : '');
      return value;
    } catch (error) {
      record(error instanceof MervError ? error.code : 'internal_error');
      throw error;
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
    // Judge aliases by their target; writes retain their own permission checks.
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
      // Mixed tools admit reads without write grants (founder, 2026-09-17).
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
      // The original provider must release its reservation even after replacement.
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
        // Authorize at dispatch: remote grants, session preparation, or native scope inside its snapshot.
        // Recheck unsnapshotted reads after the handler so revocation withholds their results.
        const snapshot = entry.snapshot(parsed);
        const dispatch = async (activeCaller: Caller) => {
          if (entry.remote)
            await this.access!.require(activeCaller, entry.remote.mountId, entry.remote.toolName);
          const run = async () => {
            if (!prepared && !entry.remote) await this.scope.require(activeCaller, 'read');
            // Nested reads retain the outer caller's vocabulary, including service-bound guidance.
            return await this.flatGuidance.run(
              this.flatGuidance.getStore() ?? (!!entry.alias || !identity.action),
              () => entry.definition.handler(activeCaller, parsed),
            );
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
                // Fence after provider awaits, before dispatch; do not reject an already committed write.
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
