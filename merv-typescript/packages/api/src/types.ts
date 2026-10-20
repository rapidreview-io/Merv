import type { View, Region } from '@merv/contracts/board-view';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Caller, Data, MervError, Principal, SessionToolPolicy } from '@merv/contracts';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodType, ZodTypeAny, ZodTypeDef } from 'zod';

/**
 * Who lists a tool, one field that MCP and Pi both read. core and deferred are every agent's (an
 * MCP client loads core up front: `_meta["anthropic/alwaysLoad"]`, Claude Code's alone); worker is
 * a bound execution's (a Pi conversation whose profile names it; a leased session as its frozen
 * policy grants); ui is Merv's own pages'. A leased session's listing does not read the tier: its
 * policy, `worker` and `for` decide it, as before tiers.
 */
export type ToolTier = 'core' | 'deferred' | 'worker' | 'ui';

/** One action of a noun tool: its own argument object, handler and contract. */
export interface NounAction<S extends ZodTypeAny = ZodTypeAny> {
  /** Any schema that produces an object, a refined one included: it is unwrapped only to
   *  describe it, and calls are validated with it as given. */
  input: S;
  /** The action's whole contract, on its argument object. */
  description: string;
  handler(caller: Caller, input: z.infer<S>): unknown | Promise<unknown>;
  /** Fields scripts rely on (ids, states, revisions, lists, cursors), as a passthrough object:
   *  it types a script's result, and is never a runtime validator. */
  output?: ZodTypeAny;
  /** The action only reads, in a noun tool whose other actions write (its `reads`). */
  readOnly?: boolean;
  /** The action calls a service outside Merv (see ToolDefinition.openWorld). */
  openWorld?: boolean;
  /** Its retired names' MCP title, as ToolDefinition.act. */
  act?: { title: string };
  /** The retired names that ran this action. Each stays callable by name as a hidden alias
   *  (Tools.alias) with this action's flat input and its own description. */
  was?: string[];
  /** As ToolDefinition.present, for this action's result and parsed arguments. */
  present?(result: unknown, input: z.infer<S>): CallToolResult;
}
export type NounActions = Record<string, NounAction>;
/** A noun tool: `action` and the argument object named after it (Tools.noun). Its description has
 *  one clause per action, at most 600 characters with the calling rule the helper adds. */
export type NounDefinition = Pick<
  ToolDefinition,
  'tier' | 'readOnly' | 'description' | 'for' | 'removed' | 'legacy'
> & { actions: NounActions };

/** A tool whose handler receives the input its schema parsed. */
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
  /** The tool calls a service outside Merv (the MCP openWorldHint). A read like this runs outside
   *  the snapshot other reads hold, so a slow remote call keeps no reader connection; it is
   *  admitted as any read and decided again before its result leaves. It must not write; a
   *  database read opens its own. A noun tool's is per action. */
  openWorld?: boolean;
  /** For a tool whose other actions write: whether this parsed input only reads. Its reads are
   *  offered to a reader's agent (its writes refused by their own checks) and run from scripts. */
  reads?(input: z.infer<S>): boolean;
  /** Default 'deferred'. A Pi profile's own tool (conversationProfile) is tier worker. */
  tier?: ToolTier;
  /** 'people': never listed to a leased session (its every call refuses a session).
   *  'conversations': listed to Pi conversations only, never to an MCP client. A noun's also keeps
   *  every retired name of its actions from leased workers, so a noun that takes one of a worker's
   *  tools takes no `for`. */
  for?: 'people' | 'conversations';
  /** 'never': no leased worker is listed it. It is a person's, whose handler refuses every
   *  worker, a page's own (ui.home), whose records a worker reads with their own tools, or a noun
   *  tool, whose retired names workers keep until their published versions drain. Called by name
   *  it still answers as it would. */
  worker?: 'never';
  /** Offer only to this server-owned Pi profile. Handlers must still enforce their bound scope. */
  conversationProfile?: string;
  /** What the tool does, in the product's words ('Submit verdict'): its MCP title. */
  act?: { title: string };
  handler(caller: Caller, input: z.infer<S>): unknown | Promise<unknown>;
  /** What an MCP client (an agent) is shown in place of the JSON result, such as a rendered
   *  image beside a text summary. Other callers receive the JSON result. */
  present?(result: unknown, input?: z.infer<S>): CallToolResult;
  /** A noun tool's actions (built by `noun`): the registry also runs their retired names. */
  actions?: NounActions;
  /** Retired names with no executable path, each answering tool_renamed with what remains: the
   *  action of this tool that took its place. */
  removed?: Record<string, string>;
  /** A noun tool's name kept from a flat tool (§2.6): a call without `action` is its old flat
   *  input, which `route` sends to an action, and a leased session is listed that old schema and
   *  text, as before. */
  legacy?: {
    inputSchema: ZodTypeAny;
    description: string;
    route(input: Record<string, unknown>): [action: string, args: Record<string, unknown>];
  };
  /** A name kept by hand until drain, spanning two nouns (nisa.research): listed to no outside
   *  agent, yet admitted for one called by name as this tool is, as a retired name would be. */
  became?: string;
}
/** How one call is known to rules keyed on a tool's name, whatever form it took: an alias as the
 *  noun action it runs, a noun call as its own action, with that action's arguments flat. `as` is
 *  the name such rules know it by: the action's first retired name, else the tool's. */
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
/** A native definition, or a remote tool's description without its handler (Tools.list()). */
export type ListedTool = ToolDefinition | (ToolDescription & { kind: 'mcp' });
/** A tool as caller rules see it: as registered. A mounted (`remote`) tool is tier deferred and
 *  never `readOnly`, whatever its server says. */
export type RegisteredTool = Pick<
  ToolDefinition,
  'name' | 'worker' | 'for' | 'conversationProfile'
> & {
  remote: boolean;
  readOnly: boolean;
  reads?: ToolDefinition['reads'];
  tier: ToolTier;
  /** A noun tool's actions, as a script's declaration reads them; absent for every other tool. */
  actions?: Record<string, NounDeclaration>;
};
/** One noun action as declared to a script: whether its object may be left out, and its declared
 *  output as JSON Schema (NounAction.output). */
export interface NounDeclaration {
  optional: boolean;
  output?: unknown;
}
/** A retired name: the tool it became and the action it is. args: every argument the old tool
 *  took, by its new name, and no other; absent, it took its action's own (a noun action's object,
 *  flat), never `action`. A noun action's `was` names are these too. */
export interface ToolAlias {
  tool: string;
  action: string;
  args?: Readonly<Record<string, string>>;
}
/** The callers one plugin issues: Pi's conversations, Sessions' managed runners and the admin's
 *  platform readers. */
export type CallerKind = 'conversation' | 'managed' | 'platform';
/** How the plugin that issues one kind of caller limits its tools; without them, 503. */
export interface CallerRules {
  /** Whether describe lists the tool to such a caller; invoke refuses any other with
   *  `forbidden`. Absent: such a caller may use no tool, and describe refuses it too. */
  offers?(tool: RegisteredTool): boolean;
  forbidden: MervError;
  /** Throws to withhold a handler's result from the caller. */
  returns?(result: unknown): void;
}
/** Throws to refuse one call, judging the registration that will run it and its parsed input;
 *  invoke runs it where caller rules admit the call. */
export type ToolAdmission = (
  tool: RegisteredTool,
  description: ToolDescription,
  input: unknown,
) => void;
export interface ToolInvocation {
  format: 'json' | 'mcp';
  value: unknown;
  /** A native tool's presentation for MCP clients, from its definition's `present`. */
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
  /** Detached descriptions for a caller, making its read decision. agent: a person's own agent over
   *  MCP, offered every native tool of tier core or deferred (a reader: those that read) plus the
   *  mounted tools its Access grants. That curates; it is no authority boundary (see POST /tools).
   *  projectless: no caller and no mounted tool, which only a project's grant lists. names: retired
   *  names to list too, as the tools they became, such as those a Pi profile names. */
  describe(
    caller?: Caller,
    agent?: boolean,
    options?: { projectless?: boolean; names?: readonly string[] },
  ): Promise<ToolDescription[]>;
  /** Every registered tool, for trusted in-process code only: it takes no caller. names: retired
   *  names to list too, as the tools they became, such as those a Pi profile names. */
  list(names?: readonly string[]): Promise<ListedTool[]>;
  /** As registered, for caller rules and listings; undefined for an unknown name. */
  tool(name: string): RegisteredTool | undefined;
  /** How rules keyed on a tool's name know this call (see ToolIdentity); `name` may be an
   *  address `tool:action`. Undefined for an unknown name. */
  identity(name: string, input: unknown): ToolIdentity | undefined;
  /** Guidance as its caller calls it: each noun action it names by its address `tool:action` is
   *  said flat for sessions and legacy calls, and as the noun for noun calls. */
  guidance<T>(caller: Caller, value: T): T;
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
