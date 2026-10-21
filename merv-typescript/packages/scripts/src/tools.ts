import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError, type Caller } from '@merv/contracts';
import type {
  RegisteredTool,
  ToolAdmission,
  ToolDefinition,
  ToolDescription,
  Tools,
} from '@merv/api/types';
import type { Scripts } from './index.js';
import { declaration } from './declare.js';

/** Native core/deferred reads, including nouns, aliases and open-world reads, are scriptable.
 * Mounted tools rely on their server’s read-only and destructive hints. */
function scriptable(
  tool: RegisteredTool,
  { annotations: hints = {} }: Pick<ToolDescription, 'annotations'>,
  input?: unknown,
) {
  if (tool.name.startsWith('script.')) return false;
  if (tool.remote) return hints.readOnlyHint === true && hints.destructiveHint !== true;
  const reads = tool.reads && (input === undefined || tool.reads(input));
  return (tool.readOnly || !!reads) && (tool.tier === 'core' || tool.tier === 'deferred');
}

async function offered(tools: Tools, caller: Caller) {
  return (await tools.describe(caller, true, { compact: false })).flatMap((description) => {
    const tool = tools.tool(description.name);
    return tool
      ? {
          description,
          native: !tool.remote,
          scriptable: scriptable(tool, description),
          actions: tool.actions,
        }
      : [];
  });
}

const admit: ToolAdmission = (tool, description, input) => {
  if (!scriptable(tool, description, input))
    throw new MervError('script_tool_refused', `${tool.name} cannot be called from a script`, 403);
};

function answer({ format, value }: { format: string; value: unknown }): unknown {
  if (format !== 'mcp') return value;
  const result = value as {
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  const text = (result.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
  if (result.isError)
    throw new MervError('remote_tool_error', text.slice(0, 500) || 'The mounted tool failed', 502);
  if (result.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const toolsInput = z.strictObject({
  query: z.string().max(200).optional(),
  names: z.array(z.string().max(128)).max(25).optional(),
  limit: z.number().int().min(1).max(25).optional(),
});
const runInput = z.strictObject({
  code: z.string().min(1).max(20_000),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
});
const words = (text = '') =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

async function find(
  tools: Tools,
  caller: Caller,
  { query, names, limit = 8 }: z.infer<typeof toolsInput>,
) {
  const all = await offered(tools, caller);
  const shown = ({ description, native, scriptable, actions }: (typeof all)[number]) => ({
    name: description.name,
    scriptable,
    declaration: declaration(description, native, actions),
  });
  if (names)
    return { tools: all.filter(({ description }) => names.includes(description.name)).map(shown) };
  if (query === undefined) {
    const namespaces = new Map<
      string,
      { namespace: string; count: number; scriptable: string[] }
    >();
    for (const { description, scriptable } of all) {
      const namespace = description.name.split('.')[0];
      const entry = namespaces.get(namespace) ?? { namespace, count: 0, scriptable: [] };
      entry.count++;
      if (scriptable) entry.scriptable.push(description.name);
      namespaces.set(namespace, entry);
    }
    return { namespaces: [...namespaces.values()] };
  }
  const wanted = words(query);
  const exact = query.trim().toLowerCase();
  const score = ({ description }: (typeof all)[number]) => {
    if (description.name.toLowerCase() === exact) return Infinity;
    const name = words(description.name);
    const text = words(description.description);
    let sum = 0;
    for (const word of wanted) sum += (name.has(word) ? 10 : 0) + (text.has(word) ? 1 : 0);
    return sum;
  };
  return {
    tools: all
      .map((entry) => ({ entry, score: score(entry) }))
      .filter(({ score }) => score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || a.entry.description.name.localeCompare(b.entry.description.name),
      )
      .slice(0, limit)
      .map(({ entry }) => shown(entry)),
  };
}

/** worker 'never' only keeps these out of a session's listing; the handler refuses the call. */
const person = (caller: Caller) =>
  check(!caller.session, 'session_forbidden', 'Scripts are not for leased workers', 403);

export function scriptTools(tools: Tools, scripts: Scripts): ToolDefinition[] {
  return [
    {
      name: 'script.tools',
      description:
        'Find the Merv tools a script.run program can call, each with a TypeScript declaration of its input. Pass query to search names and descriptions, names for exactly those tools, or neither for each namespace with its count and scriptable tools. A tool marked scriptable false cannot be called from a script.',
      inputSchema: toolsInput,
      readOnly: true,
      worker: 'never',
      handler: async (caller, input: z.infer<typeof toolsInput>) => {
        person(caller);
        return await find(tools, caller, input);
      },
    },
    {
      name: 'script.run',
      description:
        "Run a short JavaScript program on Merv that makes many reads in one call and returns only what it returns: filter and join before answering. The code is an async function body: `const p = await tools.project.read({ action: 'get' }); console.log(p.name); return p.id;` (call(name, input) is the raw form; a refused call rejects with 'code: message'). Limits: 50 calls, 4 at a time; 10 s (timeoutMs up to 30 s); 32 KiB back. Find tools and their inputs with script.tools. Reads only for now.",
      inputSchema: runInput,
      readOnly: true,
      // Each nested read owns its snapshot; holding one for the whole script exhausts readers.
      openWorld: true,
      worker: 'never',
      handler: async (caller, { code, timeoutMs = 10_000 }: z.infer<typeof runInput>) => {
        person(caller);
        // Names shape tools, not admission; retain offered nouns’ retired reads for one release.
        const listed = await offered(tools, caller);
        const shown = new Set(listed.map(({ description }) => description.name));
        const retired = (await tools.list()).flatMap((definition) =>
          'actions' in definition && shown.has(definition.name)
            ? Object.values(definition.actions ?? {}).flatMap(({ was = [] }) => was)
            : [],
        );
        const names = [
          ...listed.flatMap(({ description, scriptable }) =>
            scriptable ? [description.name] : [],
          ),
          ...retired.filter((name) => {
            const tool = tools.tool(name);
            return !!tool && scriptable(tool, {});
          }),
        ];
        return await scripts.run(code, timeoutMs, names, async (name, input) => {
          // Native calls use the caller’s project; mounted arguments (reserved _ names) stay intact.
          if (!name.startsWith('_')) {
            const { projectId, ...rest } = input;
            if (projectId !== undefined && projectId !== caller.projectId)
              throw new MervError('invalid_input', 'A script works in its own project only');
            input = rest;
          }
          return answer(await tools.invoke(name, caller, input, true, admit));
        });
      },
    },
  ];
}

export default {
  name: 'merv-scripts-tools',
  inject: ['scripts', 'tools'],
  apply(ctx: Context) {
    for (const tool of scriptTools(ctx.tools, ctx.scripts))
      ctx.effect(() => ctx.tools.register(tool));
  },
};
