import { filterAsync } from '@merv/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CallToolResultSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { MervError, type Caller, type Data, type Scope } from '@merv/contracts';
import type {
  AnyToolDefinition,
  RemoteToolDefinition,
  RemoteToolDescription,
  ToolCatalog,
  ToolDefinition,
  ToolDescription,
  ToolInvocation,
  Tools,
} from './types.js';
import { cloneJson, compileSchema } from './schema.js';
import type { ToolPolicy } from '@merv/contracts';

export class ApiError extends MervError {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(code, message, status);
    this.name = 'ApiError';
  }
}

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
    throw new ApiError('invalid_tool', 'Tool input must be an object');
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

/** Reserved even while a catalog is absent, so remote arguments keep their meaning. */
export const isMountedToolName = (name: string): boolean => name.startsWith(namespace);

/** Registrations own admission and draining; remote catalogs swap as one validated generation. */
export class ToolRegistry implements Tools {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<Promise<ToolInvocation>>();
  private readonly catalogs = new Map<string, CatalogState>();
  private stopping = false;

  constructor(
    private readonly scope: Pick<Scope, 'require'>,
    private readonly access?: Pick<ToolPolicy, 'allows' | 'require'> &
      Partial<Pick<ToolPolicy, 'allowsTool' | 'prepare' | 'validate' | 'run' | 'cancel'>>,
    /** Runs a read-only tool's handler in a snapshot scope: no writer lock, writes refused. */
    private readonly readScope?: <T>(fn: () => Promise<T>) => Promise<T>,
  ) {}

  private open(): void {
    if (this.stopping) throw new ApiError('unavailable', 'Tool registry is stopping', 503);
  }

  private prepare(definition: AnyToolDefinition, remote?: Entry['remote']): Entry {
    if (!publishedNamePattern.test(definition.name))
      throw new ApiError('invalid_tool', 'Invalid tool name');
    if (typeof definition.handler !== 'function')
      throw new ApiError('invalid_tool', 'Tool handler is required');
    if (isRemoteTool(definition)) {
      if (!remote)
        throw new ApiError('catalog_required', 'Remote tools require a catalog identity');
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
          throw new ApiError(
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
    let description: RemoteToolDescription;
    try {
      description = cloneJson(metadata);
    } catch {
      throw new ApiError('invalid_tool', 'Remote tool metadata must be JSON');
    }
    if (!ToolSchema.safeParse(description).success)
      throw new ApiError('invalid_tool', 'Remote tool description is not valid MCP');
    if (description.execution?.taskSupport && description.execution.taskSupport !== 'forbidden') {
      throw new ApiError(
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
          throw new ApiError('invalid_input', 'Remote tool input must be JSON');
        }
        if (!validate(data))
          throw new ApiError(
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
          throw new ApiError('invalid_remote_result', 'Remote tool result must be JSON', 502);
        }
        const parsed = CallToolResultSchema.safeParse(result);
        if (!parsed.success)
          throw new ApiError(
            'invalid_remote_result',
            'Remote tool returned an invalid MCP result',
            502,
          );
        if (
          !parsed.data.isError &&
          validateOutput &&
          !validateOutput(parsed.data.structuredContent)
        ) {
          throw new ApiError(
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
      throw new ApiError(
        'catalog_required',
        'Remote MCP tools must be registered through createCatalog',
      );
    if (!definition || typeof definition.name !== 'string')
      throw new ApiError('invalid_tool', 'Tool name is required');
    if (isMountedToolName(definition.name))
      throw new ApiError('reserved_namespace', 'Mounted tool namespaces are owned by catalogs');
    if (this.entries.has(definition.name))
      throw new ApiError('duplicate_tool', `Tool already registered: ${definition.name}`, 409);
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
      throw new ApiError(
        'invalid_mount',
        'Mount ID must contain 1–64 lowercase letters, digits or hyphens, beginning with a letter or digit',
      );
    if (this.catalogs.has(mountId))
      throw new ApiError('duplicate_mount', `Mount already registered: ${mountId}`, 409);
    const catalog: CatalogState = { active: true, current: new Set(), owned: new Set() };
    this.catalogs.set(mountId, catalog);
    let disposing: Promise<void> | undefined;
    return {
      replace: async (definitions) => {
        this.open();
        if (!catalog.active)
          throw new ApiError('catalog_closed', 'Remote catalog is disposed', 409);
        if (!Array.isArray(definitions))
          throw new ApiError('invalid_tool', 'Catalog definitions must be an array');
        const candidate = new Map<string, Entry>();
        for (const definition of definitions) {
          if (
            !definition ||
            !isRemoteTool(definition) ||
            typeof definition.name !== 'string' ||
            !namePattern.test(definition.name)
          )
            throw new ApiError('invalid_tool', 'Catalog entries must be named MCP tools');
          const name = `${namespace}${mountId}.${definition.name}`;
          if (candidate.has(name))
            throw new ApiError('duplicate_tool', `Duplicate remote tool: ${definition.name}`, 409);
          const current = this.entries.get(name);
          if (current && !catalog.current.has(current))
            throw new ApiError('duplicate_tool', `Tool already registered: ${name}`, 409);
          candidate.set(
            name,
            this.prepare({ ...definition, name }, { mountId, toolName: definition.name }),
          );
        }
        this.open();
        if (!catalog.active)
          throw new ApiError('catalog_closed', 'Remote catalog is disposed', 409);
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

  private sessionAccess(): Pick<
    ToolPolicy,
    'allowsTool' | 'prepare' | 'validate' | 'run' | 'cancel'
  > {
    const access = this.access;
    if (!access?.allowsTool || !access.prepare || !access.validate || !access.run || !access.cancel)
      throw new ApiError('session_unavailable', 'Session policy is unavailable', 503);
    return access as Pick<ToolPolicy, 'allowsTool' | 'prepare' | 'validate' | 'run' | 'cancel'>;
  }

  private async visible(caller?: Caller): Promise<Entry[]> {
    if (caller) await this.scope.require(caller, 'read');
    const policy = caller?.session ? this.sessionAccess() : undefined;
    return await filterAsync(
      [...this.entries.values()],
      async (entry) =>
        (!caller || !policy || (await policy.allowsTool(caller, entry.name))) &&
        (!caller ||
          !entry.remote ||
          (await this.access?.allows(caller, entry.remote.mountId, entry.remote.toolName)) ===
            true),
    );
  }

  async describe(caller?: Caller): Promise<ToolDescription[]> {
    return (await this.visible(caller))
      .map((entry) => structuredClone(entry.description))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(caller?: Caller): Promise<AnyToolDefinition[]> {
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
    const entry = this.entries.get(name);
    if (!entry) throw new ApiError('unknown_tool', `Unknown tool: ${name}`, 404);
    // Admission owns the entire operation, including asynchronous authentication and parsing.
    const operation = Promise.resolve().then(async () => {
      await this.scope.require(caller, 'read');
      if (entry.remote) {
        if (!this.access)
          throw new ApiError(
            'tool_forbidden',
            'Remote tools require an explicit access policy',
            403,
          );
        await this.access.require(caller, entry.remote.mountId, entry.remote.toolName);
      }
      const policy = caller.session ? this.sessionAccess() : undefined;
      const prepared = await policy?.prepare(caller, name, input as Data);
      try {
        const dispatchCaller = prepared?.caller ?? caller;
        const parsed = await entry.parse(prepared ? prepared.input : input);
        await policy?.validate(dispatchCaller, name, parsed as Data);
        let completed: ToolInvocation | undefined;
        const dispatch = async (activeCaller: Caller) => {
          await this.scope.require(activeCaller, 'read');
          await policy?.validate(activeCaller, name, parsed as Data);
          if (entry.remote)
            await this.access!.require(activeCaller, entry.remote.mountId, entry.remote.toolName);
          const run = async () => await entry.definition.handler(activeCaller, parsed);
          const result =
            this.readScope &&
            !entry.remote &&
            'readOnly' in entry.definition &&
            entry.definition.readOnly
              ? await this.readScope(run)
              : await run();
          completed = entry.complete(result);
          return result;
        };
        const result = prepared
          ? await policy!.run(prepared, (activeCaller) => dispatch(activeCaller))
          : await dispatch(caller);
        return completed ?? entry.complete(result);
      } finally {
        if (prepared) await policy!.cancel(prepared);
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
