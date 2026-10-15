import { z } from 'zod';
import type { MountHandler } from '@merv/api/types';
import { planDocumentSchema } from './schema.js';
import type { CustomerService } from './service.js';

/** Returned for a path this module does not serve; customerHttp then routes it as before. */
export const unhandled = Symbol('unhandled');

const revision = z.number().int().nonnegative();
const writeSchema = z.object({ expectedRevision: revision, document: planDocumentSchema }).strict();
const submitSchema = z.object({ expectedRevision: revision }).strict();
const checkoutSchema = z.object({ contractVersion: z.number().int().positive() }).strict();

/** service_experiment@3's plan document and one-step checkout. */
export async function planHttp(
  service: CustomerService,
  ...[req, , r]: Parameters<MountHandler>
): Promise<unknown> {
  const match =
    /^\/customer-experiments\/requests\/(ce_[a-f0-9]{32})\/(plan(?:\/submit)?|checkout)$/.exec(
      r.url.pathname,
    );
  if (!match) return unhandled;
  const [, id, route] = match;
  const method = req.method ?? 'GET';
  if (route === 'plan' && method === 'GET')
    return service.plan(
      (await service.access.authorize(id!, r.bearer(), req, ['agent', 'customer'])).record,
    );
  const known =
    (route === 'plan' && method === 'PUT') ||
    (route === 'plan/submit' && method === 'POST') ||
    (route === 'checkout' && method === 'POST');
  if (!known) return unhandled;
  const { record } = await service.access.requireCustomer(id!, r.bearer(), req);
  // v1/v2 keep their own checkout route and body.
  if (route === 'checkout' && !(await service.plansDocument(record))) return unhandled;
  if (route === 'plan') return service.writePlan(record, await r.json(writeSchema, 1_000_000));
  if (route === 'plan/submit') return service.submitPlan(record, await r.json(submitSchema));
  return service.checkoutPlan(record, await r.json(checkoutSchema));
}
