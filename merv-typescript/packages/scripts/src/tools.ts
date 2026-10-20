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
import type { ScriptHost } from './bridge.js';
import type { Scripts } from './index.js';
import { declaration } from './declare.js';

/** Whether a script may call this tool at all, or with this input: any read of tier core or
 *  deferred its caller could make one call at a time, open-world reads included (they keep their
 *  own budgets), a noun read and a retired read included. A mounted tool's hints are its
 *  server's word. */
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

/** What this caller is offered, each with whether a script may call it as registered now, and a
 *  noun tool's declared outputs per action. */
async function offered(tools: Tools, caller: Caller) {
  return (await tools.describe(caller, true)).flatMap((description) => {
    const tool = tools.tool(description.name);
    if (!tool) return [];
    return [
      {
        description,
        native: !tool.remote,
        scriptable: scriptable(tool, description),
        outputs: tool.outputs,
      },
    ];
  });
}

/** Decided by the registry on the registration that runs the call. */
const admit: ToolAdmission = (tool, description, input) => {
  if (!scriptable(tool, description, input))
    throw new MervError('script_tool_refused', `${tool.name} cannot be called from a script`, 403);
};

/** A tool's answer as a script sees it: a mounted tool's structured content, else its text as
 *  JSON, else its text. */
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

/** Each call is the caller's own: invoke applies every rule one call from this agent meets. */
function host(tools: Tools, caller: Caller): ScriptHost {
  return async (name, input) => {
    // A native tool's project is its caller's, as over /mcp; a mounted tool's arguments are its own.
    // The registry reserves names starting with _ for mounted tools.
    if (!name.startsWith('_')) {
      const { projectId, ...rest } = input;
      if (projectId !== undefined && projectId !== caller.projectId)
        throw new MervError('invalid_input', 'A script works in its own project only');
      input = rest;
    }
    return answer(await tools.invoke(name, caller, input, true, admit));
  };
}

const toolsInput = z
  .object({
    query: z.string().max(200).optional(),
    names: z.array(z.string().max(128)).max(25).optional(),
    limit: z.number().int().min(1).max(25).optional(),
  })
  .strict();
const runInput = z
  .object({
    code: z.string().min(1).max(20_000),
    timeoutMs: z.number().int().min(1000).max(30_000).optional(),
  })
  .strict();
const words = (text = '') =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/** What a script may call, ranked for a query, exactly as named, or summed up by namespace. */
async function find(
  tools: Tools,
  caller: Caller,
  { query, names, limit = 8 }: z.infer<typeof toolsInput>,
) {
  const all = await offered(tools, caller);
  const shown = ({ description, native, scriptable, outputs }: (typeof all)[number]) => ({
    name: description.name,
    scriptable,
    declaration: declaration(description, native, outputs),
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
  const list: ToolDefinition = {
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
  };
  const run: ToolDefinition = {
    name: 'script.run',
    description:
      "Run a short JavaScript program on Merv that makes many reads in one call and returns only what it returns: filter and join before answering. The code is an async function body: `const p = await tools.project.get({}); console.log(p.name); return p.id;` (call(name, input) is the raw form; a refused call rejects with 'code: message'). Limits: 50 calls, 4 at a time; 10 s (timeoutMs up to 30 s); 32 KiB back. Find tools and their inputs with script.tools. Reads only for now.",
    inputSchema: runInput,
    readOnly: true,
    // Not snapshotted: a snapshotted read runs inside one read snapshot its nested reads share
    // (@merv/state's snapshot), so a script would hold one reader connection for its whole run.
    // Open-world, each call inside reads on its own snapshot.
    openWorld: true,
    worker: 'never',
    handler: async (caller, { code, timeoutMs = 10_000 }: z.infer<typeof runInput>) => {
      person(caller);
      // The names only shape `tools`; each call is judged when it runs. An offered noun's
      // retired reads are there too: an agent may call them by name for one release.
      const listed = await offered(tools, caller);
      const shown = new Set(listed.map(({ description }) => description.name));
      const retired = (await tools.list()).flatMap((definition) =>
        'actions' in definition && shown.has(definition.name)
          ? Object.values(definition.actions ?? {}).flatMap(({ was = [] }) => was)
          : [],
      );
      const names = [
        ...listed.flatMap(({ description, scriptable }) => (scriptable ? [description.name] : [])),
        ...retired.filter((name) => {
          const tool = tools.tool(name);
          return !!tool && scriptable(tool, {});
        }),
      ];
      return await scripts.run(code, timeoutMs, names, host(tools, caller));
    },
  };
  return [list, run];
}

export const scriptsToolsPlugin = {
  name: 'merv-scripts-tools',
  inject: ['scripts', 'tools'],
  apply(ctx: Context) {
    for (const tool of scriptTools(ctx.tools, ctx.scripts))
      ctx.effect(() => ctx.tools.register(tool));
  },
};
export default scriptsToolsPlugin;
