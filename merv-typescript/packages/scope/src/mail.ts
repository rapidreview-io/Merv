import { z } from 'zod';
import { MervError, envName } from '@merv/contracts';

/** A Resend sender's configuration; `purpose` names what its key is for on the admin page. */
export const mailSchema = (purpose: string) =>
  z
    .object({
      apiKeyEnv: envName.describe(`${purpose} · Resend API key`),
      from: z
        .string()
        .min(3)
        .max(320)
        .refine((value) => !/[\r\n]/.test(value)),
      publicOrigin: z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '/'
          );
        }),
    })
    .strict();

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

/** Resend's transactional API. A send resolves only on Resend's receipt; any failure throws an
 *  error that carries nothing from the request or the upstream answer. */
export class ResendMailer {
  private readonly key: string;
  constructor(
    apiKeyEnv: string,
    private readonly from: string,
    private readonly fetcher = globalThis.fetch,
  ) {
    this.key = process.env[apiKeyEnv]?.trim() ?? '';
    if (!this.key) throw new MervError('email_unavailable', 'The email key is not configured', 503);
  }
  async send(mail: Mail): Promise<void> {
    const response = await this.fetcher('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${this.key}`,
        'content-type': 'application/json',
        'idempotency-key': mail.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    }).catch(() => undefined);
    const receipt = response?.ok ? await response.json().catch(() => undefined) : undefined;
    if (typeof receipt?.id !== 'string' || !receipt.id)
      throw new Error('Email delivery could not be confirmed');
  }
}

/** Merv's one email layout: a white card with the wordmark over `inner`, which is escaped HTML. */
export const emailHtml = (
  inner: string,
) => `<!doctype html><html><head><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff"><tr><td align="center" style="padding:48px 24px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;text-align:left">
<tr><td style="font-size:14px;font-weight:700;padding-bottom:36px">merv</td></tr>
<tr><td>${inner}
</td></tr></table></td></tr></table></body></html>`;
