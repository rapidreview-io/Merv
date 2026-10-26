import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const project = z.string().regex(/^[A-Za-z0-9_-]+$/);
const expiry = z.number().int().safe().positive();
const schema = z.discriminatedUnion('k', [
  z
    .object({
      k: z.literal('w'),
      p: project,
      e: z.string().min(1),
      /** The experiment's name, which Trackio's dashboard groups the attempt's runs by. */
      g: z.string().min(1).max(200),
      a: z.number().int().nonnegative(),
      x: expiry,
    })
    .strict(),
  z.object({ k: z.literal('v'), p: project, u: z.string().min(1), x: expiry }).strict(),
]);
export type Token = z.infer<typeof schema>;
export type WriteToken = Extract<Token, { k: 'w' }>;
export class Tokens {
  constructor(private secret: string) {}
  sign(token: Token): string {
    const body = Buffer.from(JSON.stringify(schema.parse(token))).toString('base64url');
    return `${body}.${this.mac(body).toString('base64url')}`;
  }
  private mac(body: string) {
    return createHmac('sha256', this.secret).update(body).digest();
  }
  verify(value: string, now = Math.floor(Date.now() / 1000)): Token | undefined {
    if (value.length > 4096 || !/^[\w-]+\.[\w-]+$/.test(value)) return;
    const [body, signature] = value.split('.') as [string, string];
    const given = Buffer.from(signature, 'base64url');
    const expected = this.mac(body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return;
    try {
      const parsed = schema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString()));
      if (parsed.success && parsed.data.x > now) return parsed.data;
    } catch {}
  }
}
