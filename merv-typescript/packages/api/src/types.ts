import type { Caller } from '@merv/contracts';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ZodTypeAny } from 'zod';
import type {} from 'cordis';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  readOnly?: boolean;
  handler(caller: Caller, input: any): unknown | Promise<unknown>;
}
/** Remote protocol descriptions retain schemas and MCP metadata without Zod conversion. */
export type RemoteToolDescription = Tool;
export interface RemoteToolDefinition extends RemoteToolDescription {
  kind: 'mcp';
  handler(caller: Caller, input: any): CallToolResult | Promise<CallToolResult>;
}
export type AnyToolDefinition = ToolDefinition | RemoteToolDefinition;
export interface ToolInvocation {
  format: 'json' | 'mcp';
  value: unknown;
}
export interface ToolCatalog {
  /** Input names are unprefixed; publication uses mount__<mountId>__<remoteName>. */
  replace(definitions: RemoteToolDefinition[]): Promise<void>;
  dispose(): Promise<void>;
}
export interface Tools {
  register(definition: AnyToolDefinition): () => Promise<void>;
  list(): AnyToolDefinition[];
  call(name: string, caller: Caller, input: unknown): Promise<unknown>;
  invoke(name: string, caller: Caller, input: unknown): Promise<ToolInvocation>;
  createCatalog(mountId: string): ToolCatalog;
}
declare module 'cordis' {
  interface Context {
    tools: Tools;
  }
}
