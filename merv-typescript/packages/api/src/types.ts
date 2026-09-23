import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Caller,
  Data,
  SessionToolPolicy,
  CodeCommandCompletion,
  CodeCommandControl,
  CodeCommandRecord,
  CodeCommitCommand,
} from '@merv/contracts';
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
/** Public tool metadata, including the native project-selection envelope. */
export type ToolDescription = Tool;
/** Remote protocol descriptions retain schemas and MCP metadata without Zod conversion. */
export type RemoteToolDescription = ToolDescription;
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
  /** Input names are unprefixed; publication uses _<mountId>.<remoteName>. */
  replace(definitions: RemoteToolDefinition[]): Promise<void>;
  dispose(): Promise<void>;
}
/**
 * Optional HTTP adapter contract. The base API does not import a Sessions implementation, and
 * it forwards request bodies as they came: the provider parses every `input` itself.
 */
export interface SessionApiProvider {
  registerAgent(caller: Caller, input: unknown): Promise<unknown>;
  agents(caller: Caller): Promise<unknown[]>;
  agent(caller: Caller, agentId: string): Promise<unknown>;
  agentObservation(caller: Caller, agentId: string): Promise<unknown>;
  retireAgent(caller: Caller, agentId: string): Promise<unknown>;
  agentSelf(token: string): Promise<unknown>;
  assignAgent(token: string, input: unknown): Promise<unknown>;
  releaseAgentAssignment(token: string, executionId: string): Promise<unknown>;
  resetAgentContext(token: string, reason: string): Promise<unknown>;
  authenticate(token: string): Promise<Caller>;
  describe(caller: Caller): Promise<unknown>;
  projectStatus(caller: Caller): Promise<unknown>;
  setDispatch(caller: Caller, input: unknown): Promise<unknown>;
  halt(caller: Caller, input: { sessionId?: string; reason?: string }): Promise<unknown>;
  lease(caller: Caller, input: unknown): Promise<unknown>;
  heartbeatRunner(caller: Caller, input: unknown): Promise<unknown>;
  setRunnerSettings(caller: Caller, input: unknown): Promise<unknown>;
  offer(caller: Caller, input: unknown): Promise<unknown>;
  list(caller: Caller): Promise<unknown[]>;
  get(caller: Caller, sessionId: string): Promise<unknown>;
  attach(caller: Caller, input: unknown): Promise<unknown>;
  workspaceResult(caller: Caller, input: unknown): Promise<unknown>;
  heartbeat(caller: Caller, input: unknown): Promise<unknown>;
  release(caller: Caller, input: unknown): Promise<unknown>;
}
/** Optional authenticated machine controls; no Code implementation is imported by the API. */
export interface CodeApiProvider {
  publications?: import('@merv/contracts').CodePublicationApi['publications'];
  syncPublications?: import('@merv/contracts').CodePublicationApi['syncPublications'];
  publicationDetails?: import('@merv/contracts').CodePublicationApi['publicationDetails'];
  mergePublication?: import('@merv/contracts').CodePublicationApi['mergePublication'];
  readonly github?: import('@merv/contracts').CodeGitHub;
  transportGrant?(
    caller: Caller,
    input: import('@merv/contracts').CodeTransportInput,
  ): Promise<import('@merv/contracts').CodeTransportGrant>;
  verifyTransport?(
    caller: Caller,
    input: import('@merv/contracts').CodeTransportInput,
  ): Promise<{ verified: boolean }>;
  nextCommand(caller: Caller, input: CodeCommandControl): Promise<CodeCommitCommand | null>;
  completeCommand(caller: Caller, input: CodeCommandCompletion): Promise<CodeCommandRecord>;
  /**
   * The second workspace protocol. The API authenticates, bounds and forwards: a route below
   * `/code/v2/` with its JSON body, or the bytes of one part. Only Code reads either, and it
   * is absent where the server keeps no repositories.
   */
  readonly v2?: {
    call(caller: Caller, route: string, body: unknown): Promise<unknown>;
    putPart(caller: Caller, operationId: string, offset: number, bytes: Buffer): Promise<unknown>;
    readPart?(caller: Caller, exportId: string, input: unknown): Promise<Buffer>;
  };
}
/** An unauthenticated handler for one plugin-owned path prefix, such as a browser bundle. */
export type MountHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export interface Api {
  readonly url?: string;
  start(): Promise<string>;
  stop(): Promise<void>;
  mount(prefix: string, handler: MountHandler): () => void;
  registerSessions(provider: SessionApiProvider): () => void;
  registerCode(provider: CodeApiProvider): () => void;
}
export interface Tools {
  register(definition: AnyToolDefinition): () => Promise<void>;
  /** Detached public descriptions. Transports must supply the authenticated caller. */
  describe(caller?: Caller): Promise<ToolDescription[]>;
  /** Omitting caller is trusted in-process inspection; transports must always supply it. */
  list(caller?: Caller): Promise<AnyToolDefinition[]>;
  call(name: string, caller: Caller, input: unknown): Promise<unknown>;
  invoke(name: string, caller: Caller, input: unknown): Promise<ToolInvocation>;
  createCatalog(mountId: string): ToolCatalog;
  /** The one provider that admits session callers; without it every session call fails closed. */
  registerSessionPolicy(provider: SessionToolPolicy): () => void;
  /** Re-admits an invocation's arguments after a later yield, such as a remote connection setup. */
  validateSession(caller: Caller, name: string, input: Data): Promise<void>;
}
declare module 'cordis' {
  interface Context {
    tools: Tools;
    api: Api;
  }
}
