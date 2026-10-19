import { check } from '@merv/contracts';

export interface ResultMailer {
  send(input: {
    to: string;
    title: string;
    url: string;
    idempotencyKey: string;
    kind?: 'submitted' | 'result';
  }): Promise<void>;
}
/** Resend's transactional API. Only an approved request's email receives its private result link. */
export class ResendResultMailer implements ResultMailer {
  constructor(
    private key: string,
    private from: string,
  ) {}
  async send(input: {
    to: string;
    title: string;
    url: string;
    idempotencyKey: string;
    kind?: 'submitted' | 'result';
  }) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject:
          input.kind === 'submitted'
            ? `Experiment submitted: ${input.title}`
            : `Your Merv experiment: ${input.title}`,
        text:
          input.kind === 'submitted'
            ? `Your experiment link:\n\n${input.url}`
            : `Your experiment has finished. Open your private page to see the result, evidence, and review:\n\n${input.url}`,
      }),
    });
    check(response.ok, 'email_unavailable', 'Result email could not be delivered yet', 503);
  }
}
