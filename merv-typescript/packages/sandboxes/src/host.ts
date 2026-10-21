import type { Context } from 'cordis';
import { bootMaintenance } from '@merv/contracts/maintenance';
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
  async apply(ctx: Context, config: MervHostConfig) {
    if (config.registerTools)
      ctx.inject(['tools'], (child) => child.effect(() => child.tools.alias(retired)));
    await host.apply(ctx, bootMaintenance.active ? { ...config, relayEvents: false } : config);
    // An existing cursor resumes verbatim. Without one, `from: now` on the next boot
    // could skip events queued during maintenance, so refuse this first-time cutover.
    if (bootMaintenance.active && config.relayEvents) {
      const previous = await ctx
        .get('sbxDb')!
        .get('SELECT id FROM domain_event_consumers WHERE id = $1', ['merv-relay']);
      if (!previous)
        throw new MervError(
          'maintenance_relay_uninitialized',
          'Initialize the Sandboxes relay before entering maintenance',
          503,
        );
    }
  },
};
