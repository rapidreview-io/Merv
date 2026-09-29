import type { Context } from 'cordis';
import { z } from 'zod';
import { idSchema } from '@merv/contracts';
import { Bindings } from './credentials.js';
import { MountRuntime } from './runtime.js';

export type { MountConfig, Mounts, MountsConfig, MountStatus } from './types.js';

const distinct = (values: string[]) => new Set(values).size === values.length;
const mountIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const mountSchema = z
  .object({
    id: mountIdSchema,
    url: z.string().refine((value) => {
      const url = URL.parse(value);
      return !!url && /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.hash;
    }, 'Mount endpoint must be HTTP(S) without user information or a fragment'),
    tools: z
      .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/))
      .min(1)
      .max(100)
      .refine(distinct, 'Selected tools must be distinct'),
    discovery: z.object({ actorId: idSchema, projectId: idSchema }).strict().optional(),
    timeoutMs: z.number().int().min(25).max(60000).optional(),
    reconnectMs: z.number().int().min(25).max(60000).optional(),
  })
  .strict();

const selectorName = /^x-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reservedSelector =
  /(?:^|-)(?:auth|authorization|bearer|key|keys|apikey|token|tokens|secret|secrets|credential|credentials|password|passwd|passphrase|pwd|signature|jwt|assertion|cookie|host|protocol|session|mcp|forwarded|proxy|connection|content|accept|origin|referer|transfer|upgrade)(?:-|$)/;
/** At most 16 distinct x-* names (compared lower-cased) with fixed printable nonsecret values. */
function selectorsAreSafe(headers: Record<string, string> | undefined) {
  const names = Object.keys(headers ?? {}).map((name) => name.toLowerCase());
  return (
    names.length <= 16 &&
    distinct(names) &&
    names.every(
      (name) => name.length <= 100 && selectorName.test(name) && !reservedSelector.test(name),
    ) &&
    Object.values(headers ?? {}).every(
      (value) =>
        value.length <= 1024 &&
        value.trim() === value &&
        /^[\x20-\x7e]+$/.test(value) &&
        !/^(?:Bearer\s|Basic\s|env:|-----BEGIN)/i.test(value),
    )
  );
}
// No enum or literal on a binding field: their issues echo the received value, which may be a secret.
const bindingSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    actorId: idSchema,
    mountId: mountIdSchema,
    secretRef: z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .refine(selectorsAreSafe, 'Only distinct nonsecret x-* selector headers are allowed')
      .transform(
        (headers) =>
          headers &&
          Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
          ),
      ),
  })
  .strict();
const configuration = z
  .object({
    mounts: z.array(mountSchema).default([]),
    bindings: z.array(bindingSchema).default([]),
  })
  .strict()
  .refine((config) => distinct(config.mounts.map((m) => m.id)), 'Mount IDs must be distinct')
  .refine(
    (config) =>
      distinct(config.bindings.map((b) => b.id)) &&
      distinct(config.bindings.map((b) => JSON.stringify([b.projectId, b.actorId, b.mountId]))),
    'Credential binding IDs and actor/project/mount selections must be unique',
  )
  .default({ mounts: [] });

/** Optional upstream connections own their catalogs and never alter native component admission. */
export const mountsPlugin = {
  name: 'merv-mounts',
  Config: configuration,
  inject: ['tools', 'scope'],
  apply(ctx: Context, config: z.output<typeof configuration>) {
    const runtimes: MountRuntime[] = [];
    // Registered first: if a later construction throws, unload still releases acquired namespaces.
    // Each stop withdraws its catalog before its first await, independent of status consumers.
    ctx.effect(() => () => Promise.all(runtimes.map((runtime) => runtime.stop())));
    const bindings = new Bindings(ctx.scope, config.bindings);
    for (const mount of config.mounts)
      runtimes.push(new MountRuntime(ctx.tools, bindings, ctx.scope, mount));
    ctx.provide('mounts', {
      status: () =>
        runtimes.map((runtime) => runtime.status()).sort((a, b) => a.id.localeCompare(b.id)),
    });
    // Optional upstreams never hold up apply; status() reports each mount's first round.
    for (const runtime of runtimes) runtime.refresh();
  },
};
export default mountsPlugin;
