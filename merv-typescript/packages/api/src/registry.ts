import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  MervError,
  type Caller,
  type Scope,
  type ToolDefinition,
  type Tools,
} from '@merv/contracts';

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

export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations: { readOnlyHint: boolean; openWorldHint: boolean };
}

interface Entry {
  definition: ToolDefinition;
  description: ToolDescription;
  running: Set<Promise<unknown>>;
}

/** Transport-independent registry. Feature adapters own registrations and await their disposers. */
export class ToolRegistry implements Tools {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(private readonly scope: Pick<Scope, 'require'>) {}

  register(definition: ToolDefinition): () => Promise<void> {
    if (this.stopping) throw new ApiError('unavailable', 'Tool registry is stopping', 503);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(definition.name)) {
      throw new ApiError('invalid_tool', 'Invalid tool name');
    }
    if (this.entries.has(definition.name))
      throw new ApiError('duplicate_tool', `Tool already registered: ${definition.name}`, 409);
    const inputSchema = zodToJsonSchema(definition.inputSchema, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    });
    if (!('type' in inputSchema) || inputSchema.type !== 'object')
      throw new ApiError('invalid_tool', 'Tool input must be an object');
    const entry: Entry = {
      definition,
      description: {
        name: definition.name,
        description: definition.description,
        inputSchema: inputSchema as ToolDescription['inputSchema'],
        annotations: { readOnlyHint: definition.readOnly ?? false, openWorldHint: false },
      },
      running: new Set(),
    };
    this.entries.set(definition.name, entry);
    return async () => {
      if (this.entries.get(definition.name) === entry) this.entries.delete(definition.name);
      await Promise.allSettled([...entry.running]);
    };
  }

  describe(): ToolDescription[] {
    return [...this.entries.values()]
      .map((entry) => structuredClone(entry.description))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  list(): ToolDefinition[] {
    return [...this.entries.values()]
      .map(({ definition }) => definition)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(name: string, caller: Caller, input: unknown): Promise<unknown> {
    if (this.stopping) throw new ApiError('unavailable', 'Tool registry is stopping', 503);
    const entry = this.entries.get(name);
    if (!entry) throw new ApiError('unknown_tool', `Unknown tool: ${name}`, 404);
    this.scope.require(caller, 'read');
    const parsed = entry.definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ApiError(
        'invalid_input',
        'Tool input failed validation',
        400,
        parsed.error.issues.map(({ path, message }) => ({ path, message })),
      );
    }
    const operation = Promise.resolve().then(() => entry.definition.handler(caller, parsed.data));
    entry.running.add(operation);
    this.running.add(operation);
    try {
      return await operation;
    } finally {
      entry.running.delete(operation);
      this.running.delete(operation);
    }
  }

  /** Stop admission immediately; wait for admitted handlers before their providers are closed. */
  async close(): Promise<void> {
    this.stopping = true;
    this.entries.clear();
    await Promise.allSettled([...this.running]);
  }
}
