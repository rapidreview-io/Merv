import { z } from 'zod';

/** Only regular files cross this boundary; archive a model directory in the job first. */
export const computeOutputsSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
            path: z
              .string()
              .min(2)
              .max(1024)
              .refine(
                (path) =>
                  path.startsWith('/') &&
                  !/[\x00-\x1f\x7f\\]/.test(path) &&
                  path
                    .split('/')
                    .slice(1)
                    .every((part) => part && part !== '.' && part !== '..'),
                'Output path must be an absolute file path without traversal',
              ),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .refine((files) => new Set(files.map((file) => file.name)).size === files.length, {
        message: 'Output names must be unique',
      }),
    maxBytes: z.number().int().min(1).max(2_147_483_648),
  })
  .strict();
