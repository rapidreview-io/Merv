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

/** The object an action's input produces, unwrapped from refinements, defaults and optionality
 *  only to describe it: calls are validated with the input as given. */
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

/** The fields of an action's object, and whether it may be left out (every field optional). */
const fields = (input: ZodTypeAny) => {
  const shape = objectShape(input);
  return {
    names: Object.keys(shape),
    optional: Object.values(shape).every((field) => field.isOptional()),
  };
};

const listed = (names: string[]) =>
  `{${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}}`;

/** A call's action and its arguments: `{action, [action]: {…}}`; an action whose fields are all
 *  optional may leave its object out. */
export function nounInput(actions: NounActions, legacy?: NounDefinition['legacy']) {
  const names = Object.keys(actions);
  if (!names.length) throw new MervError('invalid_tool', 'A noun tool has at least one action');
  const shapes = Object.fromEntries(names.map((name) => [name, fields(actions[name]!.input)]));
  const properties = Object.fromEntries(
    names.map((name) => [
      name,
      actions[name]!.input.describe(
        `Required when action is "${name}"; omit otherwise. ${actions[name]!.description}`,
      ).optional(),
    ]),
  );
  const object = z
    .object({ action: z.enum(names as [string, ...string[]]), ...properties })
    .strict();
  // Read before the arguments are: the chosen action's object is required (one whose fields are
  // all optional reads an omitted object as {}), and every other action's is refused. The
  // emitted JSON Schema cannot say either, so the server does, naming the fields.
  return z.preprocess((value, ctx) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const input = value as Record<string, unknown>;
    // A kept flat name's old flat input, without action, is checked as it was, then runs as the
    // action it routes to.
    if (legacy && !('action' in input)) {
      const flat = legacy.inputSchema.safeParse(input);
      if (!flat.success)
        for (const issue of flat.error.issues) ctx.addIssue({ ...issue, fatal: true });
      const [to, args] = flat.success ? legacy.route(flat.data) : [];
      return to ? { action: to, [to]: args } : value;
    }
    const action = input.action;
    // A missing or unknown action is the enum's own error, which lists the actions.
    if (typeof action !== 'string' || !Object.hasOwn(shapes, action)) return value;
    for (const other of names)
      if (other !== action && input[other] !== undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [other],
          message: `"${other}" belongs to action ${other}; this call is action ${action}`,
          fatal: true,
        });
    // Anything but an object there (an inner field of the same name, with the arguments left
    // flat) is told where the arguments go.
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

const RULE =
  ' Pass action and that action’s arguments under its own name, {"action":"x","x":{…}}; omit the other actions’ keys.';

/**
 * One noun tool: `action` and the argument object named after it. No worker is listed one in
 * this campaign (worker 'never') but by a name kept from a flat tool (legacy): leased workers keep
 * the retired names, which the registry runs as aliases from each action's `was`. Whether a call
 * reads is its action's.
 */
export function noun(name: string, definition: NounDefinition): ToolDefinition {
  const { actions, legacy } = definition;
  const description = definition.description + RULE;
  if (description.length > 600)
    throw new MervError('invalid_tool', `${name}'s summary is over 600 characters`);
  const openWorld = Object.values(actions).some((action) => action.openWorld);
  // Whether a call reads is its action's: every one (readOnly), or some (reads).
  const reading = Object.keys(actions).filter(
    (key) => definition.readOnly || actions[key]!.readOnly,
  );
  const readOnly = reading.length === Object.keys(actions).length;
  return {
    name,
    description,
    inputSchema: nounInput(actions, legacy),
    readOnly,
    ...(!readOnly &&
      reading.length > 0 && {
        reads: ({ action }: { action: string }) => reading.includes(action),
      }),
    ...(openWorld && { openWorld }),
    tier: definition.tier ?? 'deferred',
    ...(definition.for && { for: definition.for }),
    // A kept name stays a leased worker's, listed its old input (legacy).
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

/** Each action as a script's declaration reads it: whether its object may be left out, and its
 *  declared output as JSON Schema. */
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

/** A rule's address `tool:action` wherever guidance names one, in text or as a tool. */
const ADDRESS = /\b[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_.]*:[a-z][a-z0-9_]*\b/g;

/**
 * Guidance as its caller calls it (Tools.guidance). A rule names a noun action by its address: a
 * leased session is told the retired name its frozen policy grants, with flat arguments, exactly
 * as before the nouns; everyone else the noun tool, with the action's arguments under its own name.
 */
export function presented<T>(tools: Pick<Tools, 'identity'>, caller: Caller, value: T): T {
  const known = (address: string) => {
    const identity = tools.identity(address, {});
    return identity?.action ? identity : undefined;
  };
  const said = (address: string) => {
    const identity = known(address);
    if (!identity) return address;
    return caller.session ? identity.as : `${identity.tool} ${identity.action}`;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return node.replace(ADDRESS, said);
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const { tool, arguments: args } = node as { tool?: unknown; arguments?: unknown };
    const object = Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    const identity = typeof tool === 'string' ? known(tool) : undefined;
    if (!identity) return object;
    object.tool = caller.session ? identity.as : identity.tool;
    if (!caller.session && args && typeof args === 'object')
      object.arguments = { action: identity.action, [identity.action!]: args };
    return object;
  };
  return walk(value) as T;
}
