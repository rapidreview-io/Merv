import { z } from 'zod';
import { check, MervError } from '@merv/contracts';
import type { MountHandler } from '@merv/api/types';
import { customerDocument, type CustomerApp } from './customer-app.js';
import { planHttp, unhandled } from './plan-http.js';
import { startPage, agentInstructions, type StartPageOptions } from './start-page.js';
import type { CustomerService } from './service.js';
import { chatHttp } from './chat-http.js';
import type { FilesService } from './files.js';
import { filesHttp, isFilesPath } from './files-http.js';

// The invitation can be shared. Idempotency must be an unguessable client secret, not a title
// or counter another invite holder could replay to recover this customer's capabilities.
const createSchema = z
  .object({
    requestId: z
      .string()
      .regex(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
        'Generate a fresh UUIDv4 requestId with crypto.randomUUID()',
      ),
    title: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(32000).optional(),
  })
  .strict();
const approvalSchema = z
  .object({ contractVersion: z.number().int().positive(), email: z.string().email().max(254) })
  .strict();
const uploadSchema = z
  .object({
    requirementId: z.string().min(1).max(64),
    filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
    mediaType: z.string().max(100).optional(),
  })
  .strict();

/** Public, credential-free documentation; request creation retains its own admission gate. */
export function startHttp(
  options: StartPageOptions,
  service?: CustomerService,
  app?: CustomerApp,
): MountHandler {
  return async (req, res, r) => {
    const path = r.url.pathname;
    if (path === '/start/requests' && req.method === 'POST' && options.publicIntake && service) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return service.createPublic(await r.json(createSchema, 40000));
    }
    if (
      !['GET', 'HEAD'].includes(req.method ?? 'GET') ||
      !['/start', '/start/', '/start/agent.md'].includes(path)
    )
      throw new MervError('not_found', 'Route not found', 404);
    const markdown = path === '/start/agent.md' || req.headers.accept?.includes('text/markdown');
    // With public intake, a person who comes here opens the customer app, which makes their
    // request on their first message or files; agents still read the Markdown guide.
    const page = !markdown && options.publicIntake && app ? await app().catch(() => null) : null;
    res.setHeader(
      'Content-Type',
      markdown ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
    );
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Vary', 'Accept');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end(
      req.method === 'HEAD'
        ? undefined
        : markdown
          ? agentInstructions(options)
          : (page ?? startPage(options)),
    );
  };
}

/** `files` serves v3 request files; `app` is the v3 customer page the UI bundle builds. */
export function customerHttp(
  service: CustomerService,
  { files, app }: { files?: FilesService; app?: CustomerApp } = {},
): MountHandler {
  const chat = chatHttp(service);
  return async (req, res, r) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    const path = r.url.pathname,
      method = req.method ?? 'GET';
    const page = /^\/customer-experiments\/r\/(ce_[a-f0-9]{32})$/.exec(path);
    if (page && method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(await customerDocument(service, page[1]!, app));
      return;
    }
    if (path === '/customer-experiments/stripe-webhook' && method === 'POST') {
      check(service.payments, 'checkout_unavailable', 'Payments are not configured', 503);
      const signature = req.headers['stripe-signature'];
      check(typeof signature === 'string', 'invalid_webhook', 'Stripe signature is required', 400);
      const event = service.payments.verify(
        await r.bytes(256 * 1024, 'application/json'),
        signature,
      );
      if (event) await service.paid(event);
      return { received: true };
    }
    if (isFilesPath(path)) return filesHttp(service.access, files, req, r);
    if (path === '/customer-experiments/requests' && method === 'POST')
      return service.create(r.bearer(), await r.json(createSchema, 40000));
    const routed = chat(req, res, r);
    if (routed) return routed;
    const planned = await planHttp(service, req, res, r);
    if (planned !== unhandled) return planned;
    const match =
      /^\/customer-experiments\/requests\/(ce_[a-f0-9]{32})(?:\/(messages|accept|checkout|uploads|artifacts)(?:\/([a-zA-Z0-9_-]+)(?:\/(complete))?)?)?$/.exec(
        path,
      );
    if (!match) throw new MervError('not_found', 'Route not found', 404);
    const [, id, action, child, end] = match;
    const customerOnly = action === 'accept' || action === 'checkout';
    const { record } = await service.access.authorize(
      id!,
      r.bearer(),
      req,
      customerOnly ? ['customer'] : ['agent', 'customer'],
    );
    if (!action && method === 'GET') return service.snapshot(record);
    if (action === 'messages' && !child && method === 'POST')
      return service.message(
        record,
        await r.json(
          z
            .object({
              commandId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
              text: z.string().trim().min(1).max(32000),
            })
            .strict(),
          40000,
        ),
      );
    if (action === 'accept' && !child && method === 'POST')
      return service.accept(record, await r.json(approvalSchema));
    if (action === 'checkout' && !child && method === 'POST')
      return service.checkout(record, await r.json(approvalSchema));
    if (action === 'uploads' && !child && method === 'POST')
      return service.upload(record, await r.json(uploadSchema));
    if (action === 'uploads' && child && end === 'complete' && method === 'POST')
      return service.completeUpload(record, child);
    if (action === 'artifacts' && child && !end && method === 'GET')
      return service.artifact(record, child, r.url.searchParams.get('fileName') ?? undefined);
    throw new MervError('not_found', 'Route not found', 404);
  };
}
