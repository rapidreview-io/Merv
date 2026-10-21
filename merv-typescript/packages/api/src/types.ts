import type { View, Region } from '@merv/contracts/board-view';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Caller, Data, MervError, Principal, SessionToolPolicy } from '@merv/contracts';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodType, ZodTypeAny, ZodTypeDef } from 'zod';

/** Agent tiers: core loads up front in Claude, deferred on demand; worker binds to a Pi profile,
 * ui to pages. Leased sessions use their policy, worker and for fields, never tier. */
export type ToolTier = 'core' | 'deferred' | 'worker' | 'ui';

export interface NounAction<S extends ZodTypeAny = ZodTypeAny> {
  /** Object-producing schema; discovery unwraps it, runtime validation does not. */
  input: S;
  description: string;
  handler(caller: Caller, input: z.infer<S>): unknown | Promise<unknown>;
  /** Script output declaration only, never a runtime validator. */
  output?: ZodTypeAny;
  readOnly?: boolean;
  openWorld?: boolean;
  act?: { title: string };
  /** Hidden callable aliases with the action’s flat input and description. */
  was?: string[];
  /** 'people': its retired names are a person's, never listed to a leased session (as the noun's). */
  for?: 'people';
  present?(result: unknown, input: z.infer<S>): CallToolResult;
}
export type NounActions = Record<string, NounAction>;
export type NounDefinition = Pick<
  ToolDefinition,
  'tier' | 'readOnly' | 'description' | 'for' | 'removed' | 'legacy' | 'conversationProfile'
> & { actions: NounActions };

export interface ToolDefinition<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  /** Optional public argument schema when Zod conversion loses constraints. Runtime parsing still
   *  uses inputSchema. Object branches must be inline and use properties/required rather than
   *  property-name, property-count, dependency or whole-object enum/const constraints. Nested values
   *  may use any schema. A legacy alias still needs an object-root Zod publication. */
  inputJsonSchema?: Tool['inputSchema'];
  readOnly?: boolean;
  /** Open-world reads own their DB snapshots and recheck authority after remote calls.
   * They must not write or hold reader connections across remote waits. Per action for nouns. */
  openWorld?: boolean;
  /** Whether parsed input reads; scripts and reader discovery admit it, writes retain checks. */
  reads?(input: z.infer<S>): boolean;
  /** Default 'deferred'. A Pi profile's own tool (conversationProfile) is tier worker. */
  tier?: ToolTier;
  /** people excludes leased sessions; conversations excludes MCP. Nouns propagate to aliases. */
  for?: 'people' | 'conversations';
  /** Exclude from worker discovery only; handlers must enforce call restrictions. */
  worker?: 'never';
  /** Offer only to this server-owned Pi profile. Handlers must still enforce their bound scope. */
  conversationProfile?: string;
  act?: { title: string };
  handler(caller: Caller, input: z.infer<S>): unknown | Promise<unknown>;
  /** MCP presentation override; other callers receive the JSON result. */
  present?(result: unknown, input?: z.infer<S>): CallToolResult;
  actions?: NounActions;
  /** Removed names answer tool_renamed with the replacement action. */
  removed?: Record<string, string>;
  /** Preserve a flat tool’s schema/text for workers; route calls without action to a noun action. */
  legacy?: {
    inputSchema: ZodTypeAny;
    description: string;
    route(input: Record<string, unknown>): [action: string, args: Record<string, unknown>];
  };
  /** Manually kept alias spanning nouns: hidden from agents, admitted by the target’s rules. */
  became?: string;
}
/** Canonical tool/action with flat args; as is the first retired name, else the tool’s name. */
export interface ToolIdentity {
  tool: string;
  action?: string;
  as: string;
  args: Data;
}
/** One call by an outside agent (neither a leased session nor a Pi conversation), as logged. */
export interface AgentToolCall {
  projectId: string;
  actorId: string;
  client?: string;
  tool: string;
  action?: string;
  outcome: 'succeeded' | 'failed';
  errorCode?: string;
  startedAt: string;
  durationMs: number;
}
/** Public tool metadata, including the native project-selection envelope. */
export type ToolDescription = Tool;
/** A remote tool keeps its protocol description, schemas and MCP metadata without Zod conversion. */
export interface RemoteToolDefinition extends ToolDescription {
  kind: 'mcp';
  handler(caller: Caller, input: any): CallToolResult | Promise<CallToolResult>;
}
export type AnyToolDefinition = ToolDefinition | RemoteToolDefinition;
export type ListedTool = ToolDefinition | (ToolDescription & { kind: 'mcp' });
/** Registration metadata; remote tools are deferred and never trusted as readOnly. */
export type RegisteredTool = Pick<
  ToolDefinition,
  'name' | 'worker' | 'for' | 'conversationProfile'
> & {
  remote: boolean;
  readOnly: boolean;
  reads?: ToolDefinition['reads'];
  tier: ToolTier;
  actions?: Record<string, NounDeclaration>;
};
/** Script action declaration: optional argument object and output JSON Schema. */
export interface NounDeclaration {
  optional: boolean;
  output?: unknown;
}
/** Alias argument whitelist/renames; absent means the action’s flat fields, excluding action. */
export interface ToolAlias {
  tool: string;
  action: string;
  args?: Readonly<Record<string, string>>;
}
export type CallerKind = 'conversation' | 'managed' | 'platform';
/** How the plugin that issues one kind of caller limits its tools; without them, 503. */
export interface CallerRules {
  /** Discovery and invocation allow-list; absent refuses both with forbidden. */
  offers?(tool: RegisteredTool): boolean;
  forbidden: MervError;
  /** Throws to withhold a handler's result from the caller. */
  returns?(result: unknown): void;
}
/** Admission checks the captured registration and parsed input at invocation. */
export type ToolAdmission = (
  tool: RegisteredTool,
  description: ToolDescription,
  input: unknown,
) => void;
export interface ToolInvocation {
  format: 'json' | 'mcp';
  value: unknown;
  mcp?: CallToolResult;
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
export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>;
export interface MountOptions {
  upgrade?: UpgradeHandler;
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
  /** Builds and registers one noun tool, with its actions' retired names as hidden aliases. */
  noun(name: string, definition: NounDefinition): () => Promise<void>;
  /** Detached discovery metadata, curated without granting authority. Agents see core/deferred
   * reads as permitted and granted mounts; projectless excludes mounts. names adds aliases. */
  describe(
    caller?: Caller,
    agent?: boolean,
    options?: { projectless?: boolean; names?: readonly string[] },
  ): Promise<ToolDescription[]>;
  /** Trusted in-process listing without a caller; names adds explicitly requested aliases. */
  list(names?: readonly string[]): Promise<ListedTool[]>;
  tool(name: string): RegisteredTool | undefined;
  /** Resolve names or tool:action addresses to rule identity; undefined if unknown. */
  identity(name: string, input: unknown): ToolIdentity | undefined;
  /** Present tool:action guidance flat for sessions, legacy calls or flat; nested for noun calls. */
  guidance<T>(caller: Caller, value: T, flat?: boolean): T;
  /** `name` may be an address `tool:action` with the action's own flat arguments. */
  call(name: string, caller: Caller, input: unknown): Promise<unknown>;
  invoke(
    name: string,
    caller: Caller,
    input: unknown,
    agent?: boolean,
    admit?: ToolAdmission,
    /** The MCP client making an outside agent's call, for its log. */
    client?: string,
  ): Promise<ToolInvocation>;
  createCatalog(mountId: string): ToolCatalog;
  /** The one provider that admits session callers; without it every session call fails closed. */
  registerSessionPolicy(provider: SessionToolPolicy): () => void;
  /** The rules for one kind of caller, from the plugin that issues it (409 when registered). */
  registerCallerRules(kind: CallerKind, rules: CallerRules): () => void;
  /** Runs retired tool names, for one release, as the tool they became; listed only by name. */
  alias(resolve: (name: string) => ToolAlias | undefined): () => void;
  /** Re-admits an invocation's arguments after a later yield, such as a remote connection setup. */
  validateSession(caller: Caller, name: string, input: Data): Promise<void>;
  /** Adds a part to the guide every main agent is given (MCP instructions, Pi's prompt). */
  contributeInstructions(text: string): () => void;
  /** The contributed parts in contribution order, then the registry's own, joined by blank lines. */
  instructions(): string;
  /** Adds a reader of what a main agent's turn is told about the project as it is now: source
   *  material beside the person's message (Pi's turn context), never instructions. */
  contributeContext(read: (caller: Caller) => Promise<string | undefined>): () => void;
  /** Each reader's text for this caller in contribution order, joined by blank lines; a reader
   *  that fails or has nothing to say is left out. */
  context(caller: Caller): Promise<string>;
  /** Adds a drawer of the records whose ids begin with `prefix`: a self-contained page of one, as
   *  the caller may see it, for an agent to look at without anyone's screen (409 when taken). */
  contributePicture(prefix: string, draw: PictureDrawer): () => void;
  /** The picture of a record whose prefix has a drawer, focused on one of its parts; undefined
   *  where none draws it. */
  picture(caller: Caller, id: string, focus?: string, view?: View): Promise<Picture | undefined>;
}
/** A record drawn for looking at: a page with no scripts, at the size it is meant to be seen. */
export interface Picture {
  image?: { data: string; mimeType: 'image/jpeg' };
  viewport?: Region;
  html: string;
  width: number;
  height: number;
  /** Where the record opens in the app, for what the agent says. */
  path: string;
}
export type PictureDrawer = (
  caller: Caller,
  id: string,
  focus?: string,
  view?: View,
) => Promise<Picture | undefined>;
declare module 'cordis' {
  interface Context {
    tools: Tools;
    api: Api;
  }
}
