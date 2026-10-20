import { MervError } from '@merv/contracts';
import type { ToolDescription, ToolIdentity, Tools } from '@merv/api/types';

/** What a profile grants: each tool with the actions it may call, or null for all of them. */
export type ProfileGrants = Map<string, Set<string> | null>;

const add = (grants: ProfileGrants, tool: string, action?: string) => {
  const actions = grants.get(tool);
  if (action === undefined) grants.set(tool, null);
  else if (actions !== null) grants.set(tool, (actions ?? new Set()).add(action));
};

/**
 * A profile's `tools[]` resolved at offer time, separately from its hash: a tool name grants all of
 * that tool, an address `tool:action` that action alone, and a retired name the noun action it now
 * runs (and itself, so that a turn frozen with it still calls it).
 */
export function profileGrants(tools: Pick<Tools, 'tool'>, names: readonly string[]) {
  const grants: ProfileGrants = new Map();
  for (const name of names) {
    const colon = name.indexOf(':');
    if (colon >= 0) {
      add(grants, name.slice(0, colon), name.slice(colon + 1));
      continue;
    }
    add(grants, name);
    const alias = tools.tool(name)?.alias;
    if (alias) add(grants, alias.slice(0, alias.indexOf(':')), alias.slice(alias.indexOf(':') + 1));
  }
  return grants;
}

/** Refuses a call outside the profile: a tool it never names, or a noun action it leaves out. */
export function requireGranted(grants: ProfileGrants, name: string, identity?: ToolIdentity) {
  const granted = grants.get(name);
  if (granted === null) return;
  if (identity?.action && grants.get(identity.tool)?.has(identity.action)) return;
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
