import type { Context } from 'cordis';
import { MervError } from '@merv/contracts';
import type { ToolAlias } from '@merv/api/types';
import { renamed } from '@sandboxes/http/mcp';
import { createMervHostPlugin, type MervHostConfig } from '@sandboxes/merv-host';

/** Merv's own names for a machine's renew and delete, with their arguments. */
const MERV: Record<string, ToolAlias> = {
  'sandbox.extend': {
    tool: 'sandboxes.sandbox',
    action: 'renew',
    args: { id: 'sandbox_id', seconds: 'extend_seconds' },
  },
  'sandbox.release': { tool: 'sandboxes.sandbox', action: 'delete', args: { id: 'sandbox_id' } },
};

/** For one release the names the 2026-10-20 consolidation retired run as their action. */
export function retired(name: string): ToolAlias | undefined {
  if (Object.hasOwn(MERV, name)) return MERV[name];
  const to = name.startsWith('sandboxes.') ? renamed(name.slice('sandboxes.'.length)) : undefined;
  return to && { tool: `sandboxes.${to.tool}`, action: to.action };
}

const host = createMervHostPlugin({ MervError });
export default {
  ...host,
  apply(ctx: Context, config: MervHostConfig) {
    if (config.registerTools)
      ctx.inject(['tools'], (child) => child.effect(() => child.tools.alias(retired)));
    return host.apply(ctx, config);
  },
};
