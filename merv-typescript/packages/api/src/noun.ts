import { MervError } from '@merv/contracts';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { NounActions, NounDefinition, ToolDefinition } from './types.js';

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
export function nounInput(actions: NounActions) {
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
 * this campaign (worker 'never'): leased workers keep the retired names, which the registry
 * registers from each action's `was`.
 */
export function noun(name: string, definition: NounDefinition): ToolDefinition {
  const { actions } = definition;
  const description = definition.description + RULE;
  if (description.length > 600)
    throw new MervError('invalid_tool', `${name}'s summary is over 600 characters`);
  const openWorld = Object.values(actions).some((action) => action.openWorld);
  return {
    name,
    description,
    inputSchema: nounInput(actions),
    readOnly: definition.readOnly,
    ...(openWorld && { openWorld }),
    tier: definition.tier ?? 'deferred',
    ...(definition.for && { for: definition.for }),
    worker: 'never',
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

/** Each action's declared output as JSON Schema, for a script's declaration. */
export const nounOutputs = (actions: NounActions): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(actions).flatMap(([name, action]) =>
      action.output
        ? [[name, zodToJsonSchema(action.output, { $refStrategy: 'none', target: 'jsonSchema7' })]]
        : [],
    ),
  );
