import { MervError, type Caller } from '@merv/contracts';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  NounActions,
  NounDeclaration,
  NounDefinition,
  ToolDefinition,
  Tools,
} from './types.js';

/** Unwrap only for discovery; runtime validation retains every refinement and default. */
export function objectShape(schema: ZodTypeAny): z.ZodRawShape {
  let inner: ZodTypeAny = schema;
  for (;;) {
    if (inner instanceof z.ZodEffects) inner = inner.innerType();
    else if (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable)
      inner = inner.unwrap();
    else if (inner instanceof z.ZodDefault) inner = inner.removeDefault();
    else break;
  }
  if (!(inner instanceof z.ZodObject))
    throw new MervError('invalid_tool', 'A noun action takes an object of arguments');
  return inner.shape;
}

const fields = (input: ZodTypeAny) => {
  const shape = objectShape(input);
  return {
    names: Object.keys(shape),
    optional: Object.values(shape).every((field) => field.isOptional()),
  };
};

const listed = (names: string[]) =>
  `{${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}}`;

/** Action arguments nest under their name; all-optional objects may be omitted. */
export function nounInput(actions: NounActions, legacy?: NounDefinition['legacy']) {
  const names = Object.keys(actions);
  if (!names.length) throw new MervError('invalid_tool', 'A noun tool has at least one action');
  const shapes = Object.fromEntries(names.map((name) => [name, fields(actions[name]!.input)]));
  const properties = Object.fromEntries(
    Object.entries(actions).map(([name, { input, description }]) => [
      name,
      input
        .describe(`Required when action is "${name}"; omit otherwise. ${description}`)
        .optional(),
    ]),
  );
  const object = z.strictObject({ action: z.enum(names as [string, ...string[]]), ...properties });
  // JSON Schema cannot express the required chosen object or forbid other action objects.
  return z.preprocess((value, ctx) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const input = value as Record<string, unknown>;
    // Validate legacy flat input before routing it.
    if (legacy && !('action' in input)) {
      const flat = legacy.inputSchema.safeParse(input);
      if (!flat.success)
        for (const issue of flat.error.issues) ctx.addIssue({ ...issue, fatal: true });
      const [to, args] = flat.success ? legacy.route(flat.data) : [];
      return to ? { action: to, [to]: args } : value;
    }
    const action = input.action;
    if (typeof action !== 'string' || !Object.hasOwn(shapes, action)) return value;
    for (const other of names)
      if (other !== action && input[other] !== undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [other],
          message: `"${other}" belongs to action ${other}; this call is action ${action}`,
          fatal: true,
        });
    const given = input[action];
    if (given && typeof given === 'object' && !Array.isArray(given)) return value;
    if (given === undefined && shapes[action]!.optional) return { ...input, [action]: {} };
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [action],
      message: `action ${action} takes its arguments under "${action}": ${listed(shapes[action]!.names)}`,
      fatal: true,
    });
    return value;
  }, object);
}

const RULE = ' Use {"action":"x","x":{…}} only; x optional if all its fields are optional.';

/** Nouns dispatch nested actions; workers keep legacy flat names through registry aliases. */
export function noun(name: string, definition: NounDefinition): ToolDefinition {
  const { actions, legacy } = definition;
  const description =
    definition.description +
    ' Pass action and that action’s arguments under its own name, {"action":"x","x":{…}}; omit the other actions’ keys.';
  const summary = (definition.summary ?? definition.description) + RULE;
  if (description.length > 600)
    throw new MervError('invalid_tool', `${name}'s summary is over 600 characters`);
  const openWorld = Object.values(actions).some((action) => action.openWorld);
  const reading = Object.keys(actions).filter(
    (key) => definition.readOnly || actions[key]!.readOnly,
  );
  const readOnly = reading.length === Object.keys(actions).length;
  return {
    name,
    description,
    summary,
    inputSchema: nounInput(actions, legacy),
    readOnly,
    ...(!readOnly &&
      reading.length > 0 && {
        reads: ({ action }: { action: string }) => reading.includes(action),
      }),
    ...(openWorld && { openWorld }),
    tier: definition.tier ?? 'deferred',
    ...(definition.conversationProfile && { conversationProfile: definition.conversationProfile }),
    ...(definition.for && { for: definition.for }),
    ...(legacy ? { legacy } : { worker: 'never' as const }),
    actions,
    ...(definition.removed && { removed: definition.removed }),
    handler: async (caller, input: Record<string, unknown> & { action: string }) =>
      await actions[input.action]!.handler(caller, input[input.action] ?? {}),
    present: (result, input?: Record<string, unknown> & { action: string }) => {
      const present = input && actions[input.action]!.present;
      return present
        ? present(result, input[input.action] ?? {})
        : { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    },
  };
}

/** Script declarations include optionality and output JSON Schema. */
export const nounActions = (actions: NounActions): Record<string, NounDeclaration> =>
  Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      {
        optional: fields(action.input).optional,
        ...(action.output && {
          output: zodToJsonSchema(action.output, { $refStrategy: 'none', target: 'jsonSchema7' }),
        }),
      },
    ]),
  );

const ADDRESS = /\b[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_.]*:[a-z][a-z0-9_]*\b/g;

/** Present flat guidance to sessions and legacy/UI calls, nested guidance to noun calls. */
export function presented<T>(
  tools: Pick<Tools, 'identity'>,
  caller: Caller,
  value: T,
  flat = !!caller.session,
): T {
  const known = (address: string) => {
    const identity = tools.identity(address, {});
    return identity?.action ? identity : undefined;
  };
  const said = (address: string) => {
    const identity = known(address);
    if (!identity) return address;
    return flat ? identity.as : `${identity.tool} ${identity.action}`;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return node.replace(ADDRESS, said);
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const { tool, arguments: args } = node as { tool?: unknown; arguments?: unknown };
    const object = Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    const identity = typeof tool === 'string' ? known(tool) : undefined;
    if (!identity) return object;
    object.tool = flat ? identity.as : identity.tool;
    if (!flat && args && typeof args === 'object')
      object.arguments = { action: identity.action, [identity.action!]: args };
    return object;
  };
  return walk(value) as T;
}
