import type { z } from 'zod';
import { MervError, type ProjectInvitation } from '@merv/contracts';
import { escapeHtml } from '@merv/contracts/text';
import { emailHtml, mailSchema, ResendMailer } from './mail.js';

export interface InvitationSender {
  send(invitation: ProjectInvitation): Promise<void>;
}
export const invitationEmailSchema = mailSchema('Project invitation emails');
export type InvitationEmailConfig = z.infer<typeof invitationEmailSchema>;

export class ResendInvitationSender implements InvitationSender {
  private readonly config: InvitationEmailConfig;
  private readonly mailer: ResendMailer;
  constructor(config: InvitationEmailConfig, fetcher = globalThis.fetch) {
    this.config = invitationEmailSchema.parse(config);
    this.mailer = new ResendMailer(this.config.apiKeyEnv, this.config.from, fetcher);
  }
  async send(invitation: ProjectInvitation): Promise<void> {
    await this.mailer
      .send({
        to: invitation.email,
        subject: 'Project invitation · Merv',
        ...invitationMessage(invitation, this.config.publicOrigin),
        idempotencyKey: `project-invitation/${invitation.id}`,
      })
      .catch(() => {
        throw new MervError(
          'invitation_email_failed',
          'Invitation saved, but email delivery could not be confirmed. Retry sending from Members.',
          503,
        );
      });
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
  const html =
    emailHtml(`<h1 style="margin:0 0 20px;font-size:26px;line-height:1.2;font-weight:600">Project invitation</h1>
<p style="margin:0 0 8px;font-size:18px;line-height:1.4;overflow-wrap:anywhere">${escapeHtml(invitation.projectName)}</p>
<p style="margin:0 0 28px;font-size:14px;line-height:1.5">Role: ${escapeHtml(role)}</p>
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="background:#111111"><a href="${escapeHtml(link.href)}" style="display:inline-block;padding:14px 20px;border:1px solid #111111;background:#111111;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600">Review invitation</a></td></tr></table>
<p style="margin:28px 0 0;font-size:12px;line-height:1.7">Expires ${escapeHtml(expiry)} (UTC).</p>`);
  return { text, html };
}
