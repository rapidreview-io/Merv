import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

export const supportedProtocolVersions = [...SUPPORTED_PROTOCOL_VERSIONS];

/** Guard requests before the legacy SDK can silently ignore a newer version in _meta.
 * An initialize offer still uses the SDK's legacy negotiation and may select another version.
 * This deliberately does not implement the 2026 discovery/negotiation protocol.
 */
export function protocolError(
  header: string | string[] | undefined,
  body: unknown,
):
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      error: { code: number; message: string; data: { supportedProtocolVersions: string[] } };
    }
  | undefined {
  if (Array.isArray(body)) {
    for (const item of body) {
      const error = protocolError(header, item);
      if (error) return error;
    }
    return protocolError(header, undefined);
  }
  const message =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const params =
    message?.params && typeof message.params === 'object'
      ? (message.params as Record<string, unknown>)
      : undefined;
  const meta =
    params?._meta && typeof params._meta === 'object'
      ? (params._meta as Record<string, unknown>)
      : undefined;
  const declared = meta?.['io.modelcontextprotocol/protocolVersion'];
  const invalid = [header, declared].some(
    (value) =>
      value !== undefined &&
      (typeof value !== 'string' || !supportedProtocolVersions.includes(value)),
  );
  const conflict = header !== undefined && declared !== undefined && header !== declared;
  if (!invalid && !conflict) return undefined;
  return {
    jsonrpc: '2.0' as const,
    id: typeof message?.id === 'string' || typeof message?.id === 'number' ? message.id : null,
    error: {
      code: -32000,
      message: conflict ? 'Conflicting MCP protocol versions' : 'Unsupported MCP protocol version',
      data: { supportedProtocolVersions },
    },
  };
}
