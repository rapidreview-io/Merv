import { z } from 'zod';

/** Private launch data. This is never a Session field or a persisted runner profile. */
export const nativeMcpConnectionsSchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,31}$/)
          .refine((name) => name !== 'merv'),
        url: z
          .string()
          .max(2048)
          .url()
          .refine((value) => {
            const url = new URL(value);
            return (
              !/[\x00-\x20\x7f]/.test(value) &&
              (url.protocol === 'https:' ||
                (url.protocol === 'http:' &&
                  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash
            );
          }),
        bearer: z
          .string()
          .min(16)
          .max(4096)
          .regex(/^[\x21-\x7e]+$/)
          .refine((value) => !/^(?:m[isker]_)/.test(value)),
      })
      .strict(),
  )
  .max(4)
  .refine((values) => new Set(values.map((value) => value.name)).size === values.length);

export type NativeMcpConnection = z.infer<typeof nativeMcpConnectionsSchema>[number];
