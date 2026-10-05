import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller, Data, MervError, Principal, SessionToolPolicy } from '@merv/contracts';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodType, ZodTypeAny, ZodTypeDef } from 'zod';

export type ConversationUse = 'never' | 'propose' | 'secret';
/** A tool whose handler receives the input its schema parsed. */
export interface ToolDefinition<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  readOnly?: boolean;
  /** The tool calls a service outside Merv (the MCP openWorldHint). A read like this runs outside
   *  the snapshot other reads hold, so a slow remote call keeps no reader connection; it is
   *  admitted and re-checked as any read. It must not write; a database read opens its own. */
  openWorld?: boolean;
  /** How an agent conversation may use this tool (what it reads reaches the model provider).
   *  Omitted: the agent runs it as its person. 'propose': the person runs the proposed call.
   *  'secret': as 'propose', and only the person sees its result (a bearer secret or signed URL).
   *  'never': offered to no person's agent (only a leased worker or Merv's pages run it). A
   *  function of the parsed input decides per call. */
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
/** A native definition, or a remote tool's description without its handler (Tools.list()). */
export type ListedTool = ToolDefinition | (ToolDescription & { kind: 'mcp' });
/** A tool as caller rules see it: as registered. A mounted (`remote`) tool has no `conversation`. */
export type RegisteredTool = Pick<ToolDefinition, 'name' | 'conversation'> & { remote: boolean };
/** The callers one plugin issues: Pi's conversations and Sessions' managed runners. */
export type CallerKind = 'conversation' | 'managed';
/** How the plugin that issues one kind of caller limits its tools; without them, 503. */
export interface CallerRules {
  /** Whether describe lists the tool to such a caller; invoke refuses any other with
   *  `forbidden`. Absent: such a caller may use no tool, and describe refuses it too. */
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
/** A Scope principal, or the caller a registered credential's owner authenticated. */
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
   *  or 400 `invalid_input` with the schema's issues. Both body readers answer 503 when the
   *  mount was withdrawn during the read. */
  json<T = unknown>(schema?: ZodType<T, ZodTypeDef, unknown>, maxBytes?: number): Promise<T>;
  /** The body's bytes: 415 for any other media type, 413 past `maxBytes`. */
  bytes(maxBytes: number, mediaType: string): Promise<Buffer>;
}
/** A path prefix's handler: undefined when it responded itself, a Buffer as 200 octets, any
 *  other value as 200 JSON. */
export type MountHandler = (req: IncomingMessage, res: ServerResponse, r: ApiRequest) => unknown;
export interface MountOptions {
  /** Served without API authentication: the whole mount, or these paths and all below them. Its
   *  handler authenticates any bearer itself and answers 404 outside its exact routes. */
  public?: true | readonly `/${string}`[];
}
/** The bearers of one token namespace (such as `ms_`), registered by the plugin that issues them. */
export interface ApiCredential {
  /** The principal's kind; never user, key or actor. */
  kind: string;
  /** The refusal wherever `routes`, the allow-list checked before any I/O, is false, and on
   *  every route when `authenticate` is absent. */
  forbidden: MervError;
  routes(method: string, path: string, query: boolean): boolean;
  authenticate?(token: string): Promise<Caller>;
}

export interface Api {
  readonly url?: string;
  start(): Promise<string>;
  stop(): Promise<void>;
  /** Serves one lowercase path segment (409 when taken). Until it is mounted, and once its
   *  disposer withdraws it, a credential's request to it answers 503. */
  mount(prefix: `/${string}`, handler: MountHandler, options?: MountOptions): () => void;
  /** Authenticates the bearers of one namespace, `/^[a-z]+_$/` but never `mk_` (409 when it is
   *  taken). While a namespace is unregistered, its bearers get 503 on authenticated routes. */
  credential(namespace: `${string}_`, credential: ApiCredential): () => void;
}
export interface Tools {
  register(definition: AnyToolDefinition): () => Promise<void>;
  /** Detached public descriptions for the authenticated caller. agent: a person's own agent over
   *  MCP, offered every native tool not marked `never` (a reader: its reads alone) plus the mounted
   *  tools its Access grants. That curates; it is no authority boundary (see POST /tools). */
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
  /** Adds a part to the guide every main agent is given (MCP instructions, Pi's prompt). */
  contributeInstructions(text: string): () => void;
  /** The contributed parts in contribution order, joined by blank lines; empty without any. A
   *  session is given only its policy's own instructions. */
  instructions(caller?: 'session'): string;
}
declare module 'cordis' {
  interface Context {
    tools: Tools;
    api: Api;
  }
}
