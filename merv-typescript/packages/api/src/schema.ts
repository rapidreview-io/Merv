import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { MervError, plain } from '@merv/contracts';

/**
 * JSON snapshots isolate callers and exclude values a JSON transport cannot preserve. Remote MCP
 * metadata and results keep any key, escaped text and depth a JSON peer can send.
 */
export const cloneJson = <T>(value: T): T =>
  plain<T>(value, 'invalid_json', { keys: 'any', strings: 'json', depth: Infinity });

/** Compilation is synchronous and never fetches a reference: a remote `$ref` fails to resolve.
 *  Keywords and formats the validator does not know are annotations, as JSON Schema defines
 *  them, so an upstream's extensions (`x-*`, `discriminator`) do not refuse its catalog. */
export function compileSchema(schema: unknown): ValidateFunction {
  try {
    const snapshot = cloneJson(schema);
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot) ||
      !('type' in snapshot) ||
      snapshot.type !== 'object'
    )
      throw new Error('Tool schema must declare object input');
    const dialect = '$schema' in snapshot ? snapshot.$schema : undefined;
    // Ajv's defaults already neither coerce, insert defaults nor remove fields.
    const options = {
      strict: false,
      logger: false as const,
      allErrors: true,
      ownProperties: true,
      addUsedSchema: false,
    };
    let validator: Ajv | Ajv2020;
    if (
      dialect === undefined ||
      dialect === 'https://json-schema.org/draft/2020-12/schema' ||
      dialect === 'https://json-schema.org/draft/2020-12/schema#'
    )
      validator = new Ajv2020(options);
    else if (
      dialect === 'http://json-schema.org/draft-07/schema#' ||
      dialect === 'http://json-schema.org/draft-07/schema'
    )
      validator = new Ajv(options);
    else throw new Error('Only JSON Schema draft 2020-12 and draft-07 are supported');
    addFormats(validator);
    const validate = validator.compile(snapshot);
    // A root $async compiles an asynchronous validator; Ajv refuses a nested one itself.
    if ((validate as { $async?: unknown }).$async) throw new Error('Async schemas are unsupported');
    return validate;
  } catch (error) {
    throw new MervError(
      'invalid_schema',
      `Unsupported or invalid tool schema: ${error instanceof Error ? error.message : 'schema compilation failed'}`,
    );
  }
}
