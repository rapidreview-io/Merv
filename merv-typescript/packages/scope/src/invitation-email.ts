import { z } from 'zod';
import { MervError, envName, type ProjectInvitation } from '@merv/contracts';
import { escapeHtml } from '@merv/contracts/text';

export interface InvitationSender {
  send(invitation: ProjectInvitation): Promise<void>;
}
export const invitationEmailSchema = z
  .object({
    apiKeyEnv: envName.describe('Project invitation emails · Resend API key'),
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
export type InvitationEmailConfig = z.infer<typeof invitationEmailSchema>;

export class ResendInvitationSender implements InvitationSender {
  private readonly config: InvitationEmailConfig;
  private readonly key: string;
  constructor(
    config: InvitationEmailConfig,
    private readonly fetcher = globalThis.fetch,
  ) {
    this.config = invitationEmailSchema.parse(config);
    this.key = process.env[this.config.apiKeyEnv]?.trim() ?? '';
    if (!this.key)
      throw new MervError(
        'invitation_email_unavailable',
        'The invitation email key is not configured',
        503,
      );
  }
  async send(invitation: ProjectInvitation): Promise<void> {
    const { text, html } = invitationMessage(invitation, this.config.publicOrigin);
    try {
      const response = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${this.key}`,
          'content-type': 'application/json',
          'idempotency-key': `project-invitation/${invitation.id}`,
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [invitation.email],
          subject: 'Project invitation · Merv',
          text,
          html,
        }),
      });
      if (!response.ok) throw new Error('Email request failed');
      const result = (await response.json()) as { id?: unknown };
      if (typeof result.id !== 'string' || !result.id) throw new Error('Invalid email receipt');
    } catch {
      throw new MervError(
        'invitation_email_failed',
        'Invitation saved, but email delivery could not be confirmed. Retry sending from Members.',
        503,
      );
    }
  }
}

export function invitationMessage(
  invitation: ProjectInvitation,
  publicOrigin: string,
): { text: string; html: string } {
  const link = new URL('/ui/', publicOrigin);
  link.searchParams.set('invitation', invitation.id);
  const expiry = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(invitation.expiresAt));
  const role = invitation.role[0]!.toUpperCase() + invitation.role.slice(1);
  const text = `Project invitation\n\n${invitation.projectName}\nRole: ${role}\n\nReview invitation: ${link}\n\nExpires ${expiry} (UTC).`;
  const html = `<!doctype html><html><head><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff"><tr><td align="center" style="padding:48px 24px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;text-align:left">
<tr><td style="font-size:14px;font-weight:700;padding-bottom:36px">merv</td></tr>
<tr><td><h1 style="margin:0 0 20px;font-size:26px;line-height:1.2;font-weight:600">Project invitation</h1>
<p style="margin:0 0 8px;font-size:18px;line-height:1.4;overflow-wrap:anywhere">${escapeHtml(invitation.projectName)}</p>
<p style="margin:0 0 28px;font-size:14px;line-height:1.5">Role: ${escapeHtml(role)}</p>
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="background:#111111"><a href="${escapeHtml(link.href)}" style="display:inline-block;padding:14px 20px;border:1px solid #111111;background:#111111;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600">Review invitation</a></td></tr></table>
<p style="margin:28px 0 0;font-size:12px;line-height:1.7">Expires ${escapeHtml(expiry)} (UTC).</p>
</td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}
