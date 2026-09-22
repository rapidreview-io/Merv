import { check, createService } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from '@merv/sessions/types';
import type {} from './types.js';
import type {} from '@merv/code/service';
import { z } from 'zod';
import { CodeService } from './service.js';
import {
  defaultBackupSettings,
  postgresDump,
  S3BackupStore,
  sqliteCopy,
  type CodeBackupSettings,
} from '@merv/code/store/backup';

const bytes = z.number().int().positive().safe();
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/**
 * Only the names of environment variables, never a credential: the same rule the blobs
 * plugin keeps, and the same variables, because one bucket and one key serve both today.
 */
const backupConfig = z
  .object({
    bucketEnv: envName.default('MERV_BLOB_BUCKET'),
    endpointEnv: envName.default('MERV_BLOB_ENDPOINT_URL'),
    accessKeyIdEnv: envName.default('MERV_BLOB_ACCESS_KEY_ID'),
    secretAccessKeyEnv: envName.default('MERV_BLOB_SECRET_ACCESS_KEY'),
    regionEnv: envName.default('MERV_BLOB_REGION'),
    prefixEnv: envName.default('MERV_BLOB_PREFIX'),
    /**
     * The one segment that keeps two deployments sharing a bucket apart. Production and
     * rehearsal share a prefix today, and a copy that mixed them would restore one
     * deployment's history into the other's live project.
     */
    deploymentEnv: envName.default('MERV_TS_DB_SCHEMA'),
    everySeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400)
      .optional(),
    keepDays: z.number().int().min(1).max(3650).optional(),
    maxBytes: bytes.optional(),
    /** What is copied beside the repositories; a repository without its rows is inert. */
    database: z
      .union([
        z
          .object({
            backend: z.literal('postgres'),
            connectionStringEnv: envName.default('MERV_DB_URL'),
            schemaEnv: envName.default('MERV_TS_DB_SCHEMA'),
          })
          .strict(),
        z.object({ backend: z.literal('sqlite'), path: z.string().min(1) }).strict(),
      ])
      .optional(),
  })
  .strict();

function required(name: string): string {
  const value = process.env[name];
  check(
    value !== undefined && value.trim() !== '',
    'invalid_backup_config',
    `Required environment variable ${name} is missing`,
  );
  return value.trim();
}

/** The configured names read once, at load, so nothing later reaches for the environment. */
function backupSettings(config: z.infer<typeof backupConfig>): CodeBackupSettings {
  const deployment = required(config.deploymentEnv);
  check(
    /^[a-zA-Z0-9_-]{1,64}$/.test(deployment),
    'invalid_backup_config',
    'The backup deployment name must be a single path segment',
  );
  return {
    deployment,
    store: new S3BackupStore({
      bucket: required(config.bucketEnv),
      endpoint: required(config.endpointEnv),
      accessKeyId: required(config.accessKeyIdEnv),
      secretAccessKey: required(config.secretAccessKeyEnv),
      region: process.env[config.regionEnv],
      prefix: process.env[config.prefixEnv],
    }),
    everySeconds: config.everySeconds ?? defaultBackupSettings.everySeconds,
    keepDays: config.keepDays ?? defaultBackupSettings.keepDays,
    maxBytes: config.maxBytes ?? defaultBackupSettings.maxBytes,
    database:
      config.database?.backend === 'postgres'
        ? postgresDump(
            required(config.database.connectionStringEnv),
            required(config.database.schemaEnv),
          )
        : config.database
          ? sqliteCopy(config.database.path)
          : undefined,
  };
}
const configuration = z
  .object({
    /** Where Code keeps one repository per project. Without it the server keeps none. */
    repositories: z
      .object({
        sweepSeconds: z.number().int().min(1).max(86_400).optional(),
        drainSeconds: z.number().int().min(1).max(3600).optional(),
        /** Merge several accepted commits into one base on the server; on unless disabled. */
        autoMerge: z.boolean().optional(),
        /** How often the server looks for refs to publish; zero publishes only when asked. */
        mirrorSeconds: z.number().int().min(0).max(86_400).optional(),
        /** Where a verified copy goes. Without it the server keeps no off-host copy at all. */
        backup: backupConfig.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .default({});

export const codePlugin = {
  name: 'merv-code-research',
  Config: configuration,
  inject: ['code', 'state', 'scope', 'sessions', 'artifacts', 'workflows', 'domainEvents'],
  async apply(ctx: Context, config: z.infer<typeof configuration> = {}) {
    await ctx.effect(async function* () {
      const service = await createService(
        new CodeService(
          ctx.state,
          ctx.scope,
          ctx.sessions,
          ctx.artifacts,
          ctx.workflows,
          undefined,
          undefined,
          ctx.code.repositories &&
            (({ mirrorSeconds, autoMerge, backup, ...store }) => ({
              config: {
                ...ctx.code.repositories!.config,
                ...store,
                ...(backup ? { backup: backupSettings(backup) } : {}),
              },
              autoMerge,
              ...(mirrorSeconds === undefined ? {} : { mirrorConfig: { mirrorSeconds } }),
            }))(config.repositories ?? {}),
          ctx.code,
        ),
      );
      yield () => service.close();
      ctx.inject(['reviews'], (ctx) => {
        ctx.effect(() => service.bindReviews(ctx.reviews));
      });
      // Where a deployment runs sandboxes, a project check reaches them through this one
      // capability; no tool does, so no leased worker can ever start or stop a machine.
      ctx.inject(['sandboxes'], (ctx) => {
        ctx.effect(() => service.bindChecks(ctx.sandboxes));
      });
      // The cursor starts now because the start-up pass below covers everything before it;
      // afterwards the consumer catches up on whatever ended while Code was unloaded.
      yield await ctx.domainEvents.subscribe({
        id: 'code.reconcile.v1',
        types: ['workflow.transition'],
        from: 'now',
        handle: async (event, tx) => await service.transitioned(event, tx),
      });
      // A session's attach and end open and end its writer generation. The cursor is durable,
      // so what happened while Code was unloaded is caught up on in order.
      yield await ctx.domainEvents.subscribe({
        id: 'code.writers.v1',
        types: ['session.workspace_attached', 'session.closed'],
        from: 'now',
        handle: async (event, tx) => await service.sessionChanged(event, tx),
      });
      await service.reconcileAll();
      yield ctx.provide('codeResearch', service);
    });
  },
};
export default codePlugin;
