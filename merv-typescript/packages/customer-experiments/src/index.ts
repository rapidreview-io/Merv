import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from '@merv/pi/types';
import type {} from '@merv/sessions/types';
import type {} from '@merv/code-work/types';
import type {} from '@merv/sandboxes/sandbox-evidence';
import { z } from 'zod';
import { check } from '@merv/contracts';
import { CustomerExperiments } from './domain.js';
import { RequestStore } from './store.js';
import { RequestBuckets } from './data.js';
import { ResendResultMailer, StripePayments } from './payment.js';
import { CustomerService } from './service.js';
import { customerHttp } from './http.js';
import { registerWorkerTools } from './worker-tools.js';
import { hostedCustomerCompute } from './hosted-compute.js';

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
    computeBudgetUsd: z.number().int().min(1).max(100000).default(1000),
    computeProviders: z.array(z.string().min(1)).min(1).max(8),
    sponsor: z.object({ issuer: z.string().min(1), subject: z.string().min(1) }).strict(),
    intakeKeyEnv: env.default('MERV_CUSTOMER_INTAKE_KEY'),
    accessKeyEnv: env.default('MERV_CUSTOMER_ACCESS_KEY'),
    maxRequestsPerDay: z.number().int().min(1).max(1000).default(25),
    storage: z
      .object({
        endpoint: origin,
        region: z.string().min(1).default('us-east-1'),
        bucketPrefix: z.string().regex(/^[a-z][a-z0-9-]{2,20}$/),
        accessKeyIdEnv: env,
        secretAccessKeyEnv: env,
      })
      .strict()
      .optional(),
    stripe: z
      .object({
        secretKeyEnv: env.default('MERV_CUSTOMER_STRIPE_SECRET_KEY'),
        webhookSecretEnv: env.default('MERV_CUSTOMER_STRIPE_WEBHOOK_SECRET'),
        live: z.boolean().default(false),
      })
      .strict()
      .optional(),
    email: z
      .object({
        apiKeyEnv: env.default('MERV_CUSTOMER_RESEND_KEY'),
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
      const storage = config.storage
        ? new RequestBuckets({
            ...config.storage,
            accessKeyId: secret(config.storage.accessKeyIdEnv),
            secretAccessKey: secret(config.storage.secretAccessKeyEnv),
            publicOrigin: config.publicOrigin,
          })
        : undefined;
      if (storage) yield () => storage.close();
      const payments = config.stripe
        ? new StripePayments({
            secretKey: secret(config.stripe.secretKeyEnv),
            webhookSecret: secret(config.stripe.webhookSecretEnv),
            publicOrigin: config.publicOrigin,
            live: config.stripe.live,
          })
        : undefined;
      const mailer = config.email
        ? new ResendResultMailer(secret(config.email.apiKeyEnv), config.email.from)
        : undefined;
      check(
        !config.stripe?.live || mailer,
        'customer_configuration',
        'Live customer checkout requires a results email sender',
        503,
      );
      const service = new CustomerService(
        store,
        domain,
        ctx.scope,
        ctx.artifacts,
        ctx.pi,
        storage,
        payments,
        mailer,
        { ...config, intakeKey: secret(config.intakeKeyEnv) },
        hostedCustomerCompute(ctx, config),
      );
      for (const dispose of await service.registerIntake(ctx.tools)) yield dispose;
      yield registerWorkerTools(ctx.tools, domain);
      yield ctx.api.mount('/customer-experiments', customerHttp(service), { public: true });
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
    });
  },
};
export default customerExperimentsPlugin;
