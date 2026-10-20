import type { Context } from 'cordis';
import { MervError } from '@merv/contracts';
import type { ToolDefinition } from '@merv/api/types';
import { createMervHostPlugin, type MervHostConfig } from '@sandboxes/merv-host';

const host = createMervHostPlugin({ MervError });
/** What the host runs on project read (its READS), until its tools give `reads` themselves. */
const reads: Record<string, string[]> = {
  'sandboxes.sandbox': ['list', 'get', 'options', 'providers', 'events'],
  'sandboxes.job': ['status', 'read', 'list'],
  'sandboxes.storage': ['get', 'list', 'download', 'usage'],
  'sandboxes.workflow': ['get', 'list'],
};
const label = Symbol('tools');
/** Merv's registry as the host's tools adapter sees it: each tool registered with its reads. */
const withReads = {
  name: 'sandboxes-merv-reads',
  inject: ['tools'],
  apply(ctx: Context) {
    const { tools: registry } = ctx;
    const register = ({ name, ...rest }: ToolDefinition) =>
      registry.register({
        name,
        ...rest,
        ...(reads[name] && { reads: ({ action }) => reads[name]!.includes(action) }),
      });
    const rename = registry.rename.bind(registry);
    ctx.effect(() => ctx.isolate('tools', label).provide('tools', { register, rename }));
  },
};

export default {
  ...host,
  apply(ctx: Context, config: MervHostConfig) {
    ctx.plugin(withReads);
    return host.apply(ctx.isolate('tools', label), config);
  },
};
