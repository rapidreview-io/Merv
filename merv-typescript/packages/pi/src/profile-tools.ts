import { MervError } from '@merv/contracts';
import type { ToolDescription, ToolIdentity, Tools } from '@merv/api/types';

/** What a profile grants: each tool with the actions it may call, or null for all of them. */
export type ProfileGrants = Map<string, Set<string> | null>;

/**
 * A profile's `tools[]` resolved at offer time, separately from its hash: a tool name grants all of
 * that tool; a retired noun name resolves to its one action, an address `tool:action` that action alone.
 */
export function profileGrants(
  names: readonly string[],
  registry?: Pick<Tools, 'identity' | 'tool'>,
) {
  const grants: ProfileGrants = new Map();
  for (let name of names) {
    const identity = registry?.identity(name, {});
    if (identity?.action && registry?.tool(identity.tool)?.actions)
      name = `${identity.tool}:${identity.action}`;
    const colon = name.indexOf(':');
    const [tool, action] = colon < 0 ? [name] : [name.slice(0, colon), name.slice(colon + 1)];
    const actions = grants.get(tool);
    if (action === undefined) grants.set(tool, null);
    else if (actions !== null) grants.set(tool, (actions ?? new Set()).add(action));
  }
  return grants;
}

/** Refuses a call outside the profile: a tool it never names, or a noun action it leaves out. */
export function requireGranted(grants: ProfileGrants, name: string, identity?: ToolIdentity) {
  const granted = grants.get(name);
  if (granted === null) return;
  const actions = identity && grants.get(identity.tool);
  if (identity?.action && (actions === null || actions?.has(identity.action))) return;
  if (granted)
    throw new MervError(
      'pi_profile_action_forbidden',
      `This action of ${name} is outside the conversation role`,
      403,
    );
  throw new MervError('pi_tool_forbidden', 'This tool is outside the conversation role', 403);
}

/** A noun tool's description cut to the actions a profile grants it. */
export function restricted(description: ToolDescription, actions: Set<string> | null | undefined) {
  if (!actions) return description;
  const schema = description.inputSchema as {
    properties?: Record<string, { enum?: string[] }>;
  };
  const enumerated = schema.properties?.action?.enum;
  if (!enumerated) return description;
  const properties = Object.fromEntries(
    Object.entries(schema.properties!).filter(
      ([key]) => !enumerated.includes(key) || actions.has(key),
    ),
  );
  properties.action = {
    ...schema.properties!.action,
    enum: enumerated.filter((a) => actions.has(a)),
  };
  return { ...description, inputSchema: { ...description.inputSchema, properties } };
}
