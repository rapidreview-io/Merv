import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { record } from '@merv/contracts';

export const supportedProtocolVersions = [...SUPPORTED_PROTOCOL_VERSIONS];

/** Guard requests before the legacy SDK can silently ignore a newer version in _meta.
 * An initialize offer still uses the SDK's legacy negotiation and may select another version.
 * This deliberately does not implement the 2026 discovery/negotiation protocol.
 * A batch answers for its first refused message; an empty one for the header alone.
 */
export function protocolError(header: string | string[] | undefined, body: unknown) {
  for (const item of Array.isArray(body) ? [...body.flat(Infinity), undefined] : [body]) {
    const message = record(item);
    const declared = record(record(message?.params)?._meta)?.[
      'io.modelcontextprotocol/protocolVersion'
    ];
    const invalid = [header, declared].some(
      (value) =>
        value !== undefined &&
        (typeof value !== 'string' || !supportedProtocolVersions.includes(value)),
    );
    const conflict = header !== undefined && declared !== undefined && header !== declared;
    if (!invalid && !conflict) continue;
    return {
      jsonrpc: '2.0' as const,
      id: typeof message?.id === 'string' || typeof message?.id === 'number' ? message.id : null,
      error: {
        code: -32000,
        message: conflict
          ? 'Conflicting MCP protocol versions'
          : 'Unsupported MCP protocol version',
        data: { supportedProtocolVersions },
      },
    };
  }
  return undefined;
}
