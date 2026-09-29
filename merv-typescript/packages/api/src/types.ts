import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Caller,
  Data,
  MervError,
  Principal,
  SessionToolPolicy,
  CodeCommandCompletion,
  CodeCommandControl,
  CodeCommandRecord,
  CodeCommitCommand,
} from '@merv/contracts';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodType, ZodTypeAny, ZodTypeDef } from 'zod';
import type {} from 'cordis';

export type ConversationUse = 'never' | 'propose' | 'secret';
/** A tool whose handler receives the input its schema parsed. */
export interface ToolDefinition<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  readOnly?: boolean;
  /** The tool calls a service outside Merv (published as the MCP openWorldHint). A read like this
   * runs its handler outside the PostgreSQL snapshot every other read holds for its whole run, so
   * a slow remote call keeps none of the few reader connections. It is admitted and checked again
   * after its result exactly as any read. Nothing refuses a write there: the handler must not
   * write, and a database read it needs opens its own. */
  openWorld?: boolean;
  /** How an agent conversation may use this tool (everything a conversation reads reaches the
   * model provider). Omitted: the agent runs it as its person. 'propose': the agent only proposes
   * the exact call, which runs as the person when they press Run. 'secret': as 'propose', and its
   * result (a bearer secret or signed URL) is shown only to the person. 'never': offered to no person's
   * agent, in a conversation or over MCP (only a leased worker or Merv's own pages run it). A function of the parsed input returns 'propose' | 'secret' |
   * undefined for tools where only some uses need the person. */
  conversation?: ConversationUse | ((input: z.infer<S>) => 'propose' | 'secret' | undefined);
  handler(caller: Caller, input: z.infer<S>): unknown | Promise<unknown>;
}
/** Public tool metadata, including the native project-selection envelope. */
export type ToolDescription = Tool;
/** A remote tool keeps its protocol description, schemas and MCP metadata without Zod conversion. */
export interface RemoteToolDefinition extends ToolDescription {
  kind: 'mcp';
  handler(caller: Caller, input: any): CallToolResult | Promise<CallToolResult>;
}
export type AnyToolDefinition = ToolDefinition | RemoteToolDefinition;
/** A registered tool as Tools.list() shows it: a native definition, or a remote tool's
 *  description without its handler, which only the registry's admission may call. */
export type ListedTool = ToolDefinition | (ToolDescription & { kind: 'mcp' });
/** A tool as caller rules see it: as it was registered, whatever its definition reads now.
 *  `remote` marks a mounted tool, which has no `conversation`. */
export type RegisteredTool = Pick<ToolDefinition, 'name' | 'conversation'> & { remote: boolean };
/** The callers one plugin issues, by the Caller field it sets: Pi's conversations and Sessions'
 *  managed runners. */
export type CallerKind = 'conversation' | 'managed';
/**
 * How the plugin that issues one kind of caller limits that caller's tools (registered with
 * Tools.registerCallerRules). While none is registered, such a caller is refused 503.
 */
export interface CallerRules {
  /** Whether such a caller is offered the tool: describe lists it, and invoke refuses any other
   *  with `forbidden`. Absent: such a caller may use no tool, and describe refuses it too. */
  offers?(tool: RegisteredTool): boolean;
  forbidden: MervError;
  /** Throws to refuse one call with its parsed input, before its handler runs. */
  admits?(tool: RegisteredTool, input: unknown): void;
  /** Throws to withhold a handler's result from the caller. */
  returns?(result: unknown): void;
}
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
  /** Optional hosted-runner enrollment; absent means fail closed. */
  enrollManaged?(token: string, input: unknown): Promise<{ controlToken: string; caller: Caller }>;
  authenticateManaged?(token: string): Promise<Caller>;
  registerAgent(caller: Caller, input: unknown): Promise<unknown>;
  agents(caller: Caller): Promise<unknown[]>;
  agent(caller: Caller, agentId: string): Promise<unknown>;
  agentObservation(caller: Caller, agentId: string): Promise<unknown>;
  retireAgent(caller: Caller, agentId: string): Promise<unknown>;
  rotateAgent(caller: Caller, agentId: string): Promise<unknown>;
  agentSelf(token: string): Promise<unknown>;
  assignAgent(token: string, input: unknown): Promise<unknown>;
  releaseAgentAssignment(token: string, executionId: string): Promise<unknown>;
  resetAgentContext(token: string, reason: string): Promise<unknown>;
  authenticate(token: string): Promise<Caller>;
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
/** Who the API authenticated: a Scope principal, or the caller a registered credential's owner
 *  authenticated (whose kind is never user, key or actor). */
export type ApiPrincipal = Principal | { kind: string; caller: Caller };
/** One request to a mounted handler. */
export interface ApiRequest {
  readonly url: URL;
  /** Set before the handler on an authenticated route; absent on a public one. */
  readonly principal?: ApiPrincipal;
  /** The raw bearer, or 401 without one: a public handler authenticates it itself. */
  bearer(): string;
  /** The caller in the project that X-Merv-Project-Id and `projectId` select (400 when they
   *  conflict): one read decision, made before any body. 401 on a public route. */
  caller(projectId?: string): Promise<Caller>;
  /** The JSON body: 415, 413 past `maxBytes` (default the server's limit), 400 `invalid_json`,
   *  or 400 `invalid_input` with the schema's issues. */
  json<T = unknown>(schema?: ZodType<T, ZodTypeDef, unknown>, maxBytes?: number): Promise<T>;
  /** The body's bytes: 415 for any other media type, 413 past `maxBytes`. */
  bytes(maxBytes: number, mediaType: string): Promise<Buffer>;
  // json and bytes answer 503 `unavailable` when the mount was withdrawn while the body was read.
}
/**
 * The handler of one plugin-owned path prefix. It returns undefined when it wrote the response
 * itself; a Buffer is sent as 200 octets and any other value as 200 JSON.
 */
export type MountHandler = (req: IncomingMessage, res: ServerResponse, r: ApiRequest) => unknown;
export interface MountOptions {
  /** Served without API authentication: the whole mount, or these paths under it, each with
   *  everything below it. A public handler authenticates any bearer itself and answers 404
   *  outside its exact routes. */
  public?: true | readonly `/${string}`[];
}
/** The bearers of one token namespace (such as `ms_`), registered by the plugin that issues them. */
export interface ApiCredential {
  /** The principal's kind; never user, key or actor. */
  kind: string;
  /** The refusal wherever `routes` is false. */
  forbidden: MervError;
  /** The authenticated routes this credential may use: an allow-list checked before any I/O. */
  routes(method: string, path: string, query: boolean): boolean;
  /** Absent: the API never authenticates the credential and answers `forbidden`. */
  authenticate?(token: string): Promise<Caller>;
}

export interface Api {
  readonly url?: string;
  start(): Promise<string>;
  stop(): Promise<void>;
  /** Serves one lowercase path segment (409 `mount_conflict` when it is taken). The disposer
   *  withdraws it: its routes then answer 503 until it is mounted again. */
  mount(prefix: `/${string}`, handler: MountHandler, options?: MountOptions): () => void;
  /** Authenticates the bearers of one namespace, `/^[a-z]+_$/` but never `mk_` (409 when it is
   *  taken). While a namespace is unregistered, its bearers get 503 on authenticated routes. */
  credential(namespace: `${string}_`, credential: ApiCredential): () => void;
  registerSessions(provider: SessionApiProvider): () => void;
  registerCode(provider: CodeApiProvider): () => void;
}
export interface Tools {
  register(definition: AnyToolDefinition): () => Promise<void>;
  /** Detached public descriptions. Transports must supply the authenticated caller. agent: the
   *  caller is a person's own agent over MCP. MCP offers it every native tool not marked `never`
   *  (a reader: its reads alone) plus the mounted tools its Access grants. This curates what an
   *  agent is offered; it is not an authority boundary: the same credential may call any tool it
   *  is permitted over POST /tools. */
  describe(caller?: Caller, agent?: boolean): Promise<ToolDescription[]>;
  /** Every registered tool, for trusted in-process code only: it takes no caller. */
  list(): Promise<ListedTool[]>;
  call(name: string, caller: Caller, input: unknown): Promise<unknown>;
  invoke(name: string, caller: Caller, input: unknown, agent?: boolean): Promise<ToolInvocation>;
  createCatalog(mountId: string): ToolCatalog;
  /** The one provider that admits session callers; without it every session call fails closed. */
  registerSessionPolicy(provider: SessionToolPolicy): () => void;
  /** The rules for one kind of caller, from the plugin that issues it (409 when registered). */
  registerCallerRules(kind: CallerKind, rules: CallerRules): () => void;
  /** Re-admits an invocation's arguments after a later yield, such as a remote connection setup. */
  validateSession(caller: Caller, name: string, input: Data): Promise<void>;
}
declare module 'cordis' {
  interface Context {
    tools: Tools;
    api: Api;
  }
}
