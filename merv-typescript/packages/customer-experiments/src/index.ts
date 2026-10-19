import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from '@merv/pi/types';
import type {} from '@merv/sessions/types';
import type {} from '@merv/code-work/types';
import type {} from '@merv/ui/types';
import type {} from '@merv/sandboxes/sandbox-evidence';
import type {} from '@merv/identity/types';
import { z } from 'zod';
import { check } from '@merv/contracts';
import { CustomerExperiments } from './domain.js';
import { RequestStore } from './store.js';
import { RequestBuckets } from './data.js';
import type {} from '@merv/contracts/payments';
import { ResendResultMailer } from './mail.js';
import { CUSTOMER_PRODUCT, CustomerService } from './service.js';
import { customerHttp, startHttp } from './http.js';
import { registerWorkerTools } from './worker-tools.js';
import { FilesService } from './files.js';
import { hostedCustomerCompute } from './hosted-compute.js';
import { plansDocument } from './program.js';
import type { StandaloneExperiments } from './models.js';

const env = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const origin = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return u.protocol === 'https:' && u.origin === value;
  }, 'Use an HTTPS origin');
export const customerConfig = z
  .object({
    publicOrigin: origin,
    computeProjectId: z.string().min(1),
    computeBudgetUsd: z.number().int().min(1).max(100000).nullable().default(null),
    computeProviders: z.array(z.string().min(1)).min(1).max(8),
    sponsor: z.object({ issuer: z.string().min(1), subject: z.string().min(1) }).strict(),
    publicIntake: z.boolean().default(false),
    intakeKeyEnv: env
      .describe('Standalone experiment requests · intake key')
      .default('MERV_CUSTOMER_INTAKE_KEY'),
    accessKeyEnv: env
      .describe('Standalone experiment customer links · signing secret')
      .default('MERV_CUSTOMER_ACCESS_KEY'),
    maxRequestsPerDay: z.number().int().min(1).max(1000).default(25),
    storage: z
      .object({
        endpoint: origin,
        region: z.string().min(1).default('us-east-1'),
        bucketPrefix: z.string().regex(/^[a-z][a-z0-9-]{2,20}$/),
        accessKeyIdEnv: env.describe('Standalone experiment data buckets · S3 access key id'),
        secretAccessKeyEnv: env.describe('Standalone experiment data buckets · S3 secret key'),
      })
      .strict()
      .optional(),
    email: z
      .object({
        apiKeyEnv: env
          .describe('Standalone experiment result emails · Resend API key')
          .default('MERV_CUSTOMER_RESEND_KEY'),
        from: z.string().min(1).max(254),
      })
      .strict()
      .optional(),
  })
  .strict();
const secret = (name: string) => {
  const value = process.env[name];
  check(
    value && value.trim(),
    'customer_configuration',
    `Missing environment setting ${name}`,
    503,
  );
  return value;
};
export const customerExperimentsPlugin = {
  name: 'merv-customer-experiments',
  Config: customerConfig,
  inject: [
    'state',
    'scope',
    'artifacts',
    'workflows',
    'reviews',
    'codeWork',
    'sessions',
    'sandboxEvidence',
    'reports',
    'sbxMerv',
    'sbxAccounts',
    'sbxDb',
    'sbxBilling',
    'sbxProviders',
    'sbxVault',
    'sbxSettings',
    'sbxResourceLimits',
    'pi',
    'tools',
    'api',
  ],
  async apply(ctx: Context, config: z.infer<typeof customerConfig>) {
    await ctx.effect(async function* () {
      const store = new RequestStore(ctx.state, secret(config.accessKeyEnv));
      await store.initialize();
      const domain = new CustomerExperiments(
        ctx.state,
        ctx.scope,
        ctx.artifacts,
        ctx.workflows,
        ctx.reviews,
        ctx.codeWork,
        ctx.sessions,
        undefined,
        ctx.sandboxEvidence,
      );
      await domain.initialize();
      yield () => domain.close();
      yield domain.bindReports(ctx.reports);
      const storage = config.storage
        ? new RequestBuckets({
            ...config.storage,
            accessKeyId: secret(config.storage.accessKeyIdEnv),
            secretAccessKey: secret(config.storage.secretAccessKeyEnv),
            publicOrigin: config.publicOrigin,
          })
        : undefined;
      if (storage) yield () => storage.close();
      const mailer = config.email
        ? new ResendResultMailer(secret(config.email.apiKeyEnv), config.email.from)
        : undefined;
      // The request bucket's files; the plan freezes their manifest into a v3 contract.
      const files: FilesService = new FilesService(ctx.state, store, storage, async (record) => {
        check(record.experimentId, 'request_initializing', 'Request is initializing', 409);
        const caller = await service.caller(record);
        const { workflow } = await domain.get(caller, record.experimentId);
        return plansDocument(workflow.version)
          ? { ...workflow, planStatus: (await domain.plan(caller, record.experimentId)).status }
          : workflow;
      });
      await files.initialize();
      const service = new CustomerService(
        store,
        domain,
        ctx.scope,
        ctx.artifacts,
        ctx.pi,
        storage,
        () => ctx.get('payments'),
        mailer,
        { ...config, intakeKey: secret(config.intakeKeyEnv) },
        hostedCustomerCompute(ctx, config),
        files,
      );
      service.access.activity = (id) => files.touch(id);
      const standalone: StandaloneExperiments = {
        snapshot: async (id) => await service.snapshot(await store.get(id)),
        customers: store.customers.bind(store),
      };
      yield ctx.provide('customerExperiments', standalone);
      // Optional: without identity, service_experiment@3 customers are refused with a 503.
      ctx.inject(['identity'], (ctx) => {
        ctx.effect(() => {
          service.access.identity = ctx.identity;
          return () => {
            if (service.access.identity === ctx.identity) service.access.identity = undefined;
          };
        });
      });
      const start = {
        publicOrigin: config.publicOrigin,
        publicIntake: config.publicIntake,
        get livePayments() {
          return !!ctx.get('payments')?.live;
        },
      };
      // Optional: without Payments, checkout is refused with a 503 and the plan stays saved.
      ctx.inject(['payments'], (ctx) => {
        ctx.effect(() => ctx.payments.fulfil(CUSTOMER_PRODUCT, (paid) => service.paid(paid)));
      });
      for (const dispose of await service.registerIntake(ctx.tools)) yield dispose;
      yield registerWorkerTools(ctx.tools, domain, files);
      // v3 requests open the customer app the UI bundle builds, where the UI is loaded.
      const app = async () => await ctx.get('ui')?.document('customer');
      yield ctx.api.mount('/customer-experiments', customerHttp(service, { files, app }), {
        public: true,
      });
      yield ctx.api.mount('/start', startHttp(start, service, app), { public: true });
      let pending: Promise<void> | undefined;
      const tick = () => {
        if (!pending)
          pending = service
            .reconcile()
            .catch(() => {})
            .finally(() => {
              pending = undefined;
            });
      };
      const timer = setInterval(tick, 10000);
      timer.unref();
      tick();
      yield async () => {
        clearInterval(timer);
        await pending;
      };
      let sweeping: Promise<void> | undefined;
      const sweeper = setInterval(() => {
        sweeping ??= files.sweep().finally(() => {
          sweeping = undefined;
        });
      }, 600_000);
      sweeper.unref();
      yield async () => {
        clearInterval(sweeper);
        await sweeping;
      };
    });
  },
};
export default customerExperimentsPlugin;
