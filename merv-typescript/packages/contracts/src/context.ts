/** Context Builder's contract: recipes, items, packages and the service. */
import type { Transaction } from './index.js';
import type { Caller } from './scope-models.js';
interface ContextRecipe {
  instructions: string;
  /** A required section needs at least one item. */
  sections: { key: string; title: string; required: boolean }[];
  outputInstructions: string;
  /** The only budget, in UTF-16 code units (JavaScript string length). */
  maxChars: number;
  /** 2: the item renderer. Absent in retired versions, which register refuses; optional so their
   *  definitions keep their hashes. */
  format?: 2;
}
export interface ContextRecipeDefinition {
  name: string;
  version: number;
  kind: 'work' | 'review';
  recipe: ContextRecipe;
}
/** A unit of a context. Every item is listed by one line or embedded as one block. */
export interface ContextItem {
  /** Printed on one line, clipped to 300; two IDs equal after that fail invalid_context. */
  id: string;
  /** Printed on one line, clipped to 200. */
  title: string;
  body: { text: string } | { artifactId: string };
  /**
   * `always` embeds the body or fails the build; `fit` (the default) embeds it while it fits,
   * reading an artifact only when its media type is textual; `never` lists the item only.
   */
  embed?: 'always' | 'fit' | 'never';
  /** Higher first when room runs out; default 0. */
  priority?: number;
  /** Printed on the item's line or its block's heading, folded to one line, clipped to 300. */
  note?: string;
  /** At most 8, printed as given on the item's line. */
  refs?: { tool: string; input: Record<string, string | number | boolean | null> }[];
}
export interface ContextInput {
  items: ContextItem[];
}
export interface ContextBuild {
  subject: { id: string; revision: number; claimId?: string };
  inputs: Record<string, ContextInput>;
  requestId: string;
}
/** An artifact a context draws on, as its package records it. */
export interface ContextSource {
  id: string;
  title: string;
  mediaType: string;
  hash: string;
  size: number;
}
export interface ContextPackage {
  id: string;
  projectId: string;
  actorId: string;
  type: string;
  typeVersion: number;
  recipeHash: string;
  subject: ContextBuild['subject'];
  prompt: string;
  /** Every artifact the build resolved, whether or not its bytes are in the prompt. A package
   *  saved before sources were narrowed keeps the full artifact rows it recorded. */
  sources: ContextSource[];
  omitted: string[];
  hash: string;
  createdAt: string;
}
export type ContextPreview = Omit<ContextPackage, 'id' | 'createdAt'>;
/** The input of `build`: a preview to save under a request ID. */
interface ContextSave {
  requestId: string;
  preview: ContextPreview;
}
export interface ContextRegistration {
  /**
   * With `tx`, or without it inside a transaction, runs there: the caller chose the placement,
   * and a writer transaction holds the writer lock while bytes are read. Outside any
   * transaction, authorization and artifact metadata are read in a read-only snapshot and the
   * bytes after it closes, so the builder never takes the writer lock.
   */
  preview(
    caller: Caller,
    input: Omit<ContextBuild, 'requestId'>,
    tx?: Transaction,
  ): Promise<ContextPreview>;
  /**
   * Saves a preview this registration returned, unchanged, once per project, actor and request
   * ID. In-process only: a preview is recognised by object identity, so build can never be
   * offered over HTTP or MCP. A request ID already saved returns its package when the recipe and
   * subject match, whatever inputs produced it; any other recipe or subject fails
   * request_conflict.
   */
  build(caller: Caller, input: ContextSave, tx?: Transaction): Promise<ContextPackage>;
  /** Replay an existing assignment request before rebuilding its live inputs. Placed as
   *  `preview` is: outside any transaction it reads in a read-only snapshot. */
  replay(
    caller: Caller,
    input: Pick<ContextBuild, 'subject' | 'requestId'>,
    tx?: Transaction,
  ): Promise<ContextPackage | null>;
  dispose(): void;
}
export interface ContextBuilder {
  register(definition: ContextRecipeDefinition): Promise<ContextRegistration>;
}
