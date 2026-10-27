import { check, envName } from '@merv/contracts';
import type { IssueLevel } from '@merv/contracts/issues';
import { z } from 'zod';

/** What one alert says: codes and counts only, never a note or anything an agent wrote. */
export interface AlertDigest {
  at: string;
  /** An empty id links the Issues page itself. */
  issues: {
    id: string;
    title: string;
    level: IssueLevel;
    loop: boolean;
    count: number;
    openedAt: string;
  }[];
}
/** Where severe issues are pushed; every configured sink receives every digest. */
export interface AlertSink {
  readonly name: string;
  send(digest: AlertDigest): Promise<void>;
}

export const slackConfig = z
  .object({
    webhookEnv: envName
      .describe('Issue alerts · Slack webhook URL')
      .default('MERV_ISSUES_SLACK_WEBHOOK'),
    publicOrigin: z.string().url(),
  })
  .strict();

const words = (code: string) => code.replace(/[._:-]+/g, ' ').trim();
/** An issue as an alert and the board name it: `words(where) · words(code)`. */
export const title = (where: string, code: string) => `${words(where)} · ${words(code)}`;
const mrkdwn = (text: string) =>
  text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);
const stamp = (at: string) => `${at.slice(0, 16).replace('T', ' ')} UTC`;

/** A Slack incoming webhook, read from the environment at each send so a replaced URL applies at
 *  once. Its URL is never logged; a non-2xx answer throws, so the issues stay owed. */
export function slackSink({ webhookEnv, publicOrigin }: z.infer<typeof slackConfig>): AlertSink {
  const link = (id: string) =>
    `${publicOrigin}/ui/admin/issues${id ? `?issue=${encodeURIComponent(id)}` : ''}`;
  return {
    name: 'slack',
    async send({ at, issues }) {
      const url = process.env[webhookEnv];
      check(url, 'slack_unavailable', 'The Slack webhook for issue alerts is not configured', 503);
      const text =
        issues.length === 1
          ? `Merv · ${issues[0]!.title}`
          : `Merv · ${issues.length} severe issues`;
      const blocks = [
        ...issues.map((issue) => ({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `<${link(issue.id)}|${mrkdwn(issue.title)}> · ${issue.count.toLocaleString('en-US')} · since ${stamp(issue.openedAt)}`,
          },
        })),
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Digest ${stamp(at)}` }] },
      ];
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, blocks }),
        signal: AbortSignal.timeout(10_000),
      });
      check(response.ok, 'slack_refused', `Slack answered ${response.status}`, 502);
    },
  };
}
