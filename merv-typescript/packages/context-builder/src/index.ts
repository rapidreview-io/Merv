import { clip, visible, recorded } from '@merv/contracts';
import { createService } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { renderItems, type ResolvedArtifacts } from './items.js';
import type { Context } from 'cordis';
import { z } from 'zod';
import {
  check,
  digest,
  inTransaction,
  MervError,
  newId,
  now,
  type State,
  type Scope,
  type Artifacts,
  type Caller,
  type TaskTypeDefinition,
  type ContextBuilder,
  type ContextRegistration,
  type ContextBuild,
  type ContextPackage,
  type ContextPreview,
  type Sql,
  type Transaction,
  type Artifact,
} from '@merv/contracts';

const identifier = z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/);
const refs = z.array(
  z
    .object({
      tool: identifier,
      input: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    })
    .strict(),
);
/** Caller text on one line: every run of white space and line breaks becomes one space. */
const oneLine = (max: number) =>
  z
    .string()
    .transform((text) => clip(text.replace(/[\s\u0085]+/g, ' ').trim(), max).trim())
    .pipe(z.string().min(1));
const item = z
  .object({
    id: oneLine(300),
    title: oneLine(200),
    body: z.union([
      z.object({ text: z.string() }).strict(),
      z.object({ artifactId: z.string().min(1) }).strict(),
    ]),
    embed: z.enum(['always', 'fit', 'never']).optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    note: oneLine(300).optional(),
    refs: refs.max(8).optional(),
  })
  .strict();
const definitionSchema = z
  .object({
    name: identifier,
    version: z.number().int().positive(),
    kind: z.enum(['work', 'review']),
    recipe: z
      .object({
        instructions: z.string().trim().min(1).refine(visible),
        outputInstructions: z.string().trim().min(1).refine(visible),
        sections: z
          .array(
            z
              .object({
                key: z.string().regex(/^[a-z][a-zA-Z0-9_.-]{0,127}$/),
                title: z.string().trim().min(1).refine(visible),
                required: z.boolean(),
              })
              .strict(),
          )
          .min(1),
        maxChars: z.number().int().min(1000).max(200000),
        format: z.literal(2).optional(),
      })
      .strict(),
  })
  .strict();
const buildSchema = z
  .object({
    subject: z
      .object({
        id: z.string().min(1),
        revision: z.number().int().nonnegative(),
        claimId: z.string().min(1).optional(),
      })
      .strict(),
    inputs: z.record(z.object({ items: z.array(item) }).strict()),
    requestId: z.string().trim().min(1).max(200).refine(visible),
  })
  .strict();
const previewSchema = buildSchema.omit({ requestId: true });
const replaySchema = buildSchema.omit({ inputs: true });
const saveSchema = z
  .object({
    requestId: buildSchema.shape.requestId,
    preview: z.custom<ContextPreview>((value) => typeof value === 'object' && value !== null),
  })
  .strict();

/** Permanent: these stored bytes will never read back. blob_not_found is not here (a restored blob or
 *  a fixed bucket or prefix brings it back), and neither is any transient code. */
const PERMANENT = new Set(['artifact_size', 'artifact_hash_mismatch', 'blob_corrupt']);
/** The document's text. null when it has none (its bytes are not UTF-8), or when `lenient` and its
 *  bytes are permanently unreadable. Everything else propagates, so a pinned prompt never records
 *  an outage. */
async function readText(
  artifacts: Artifacts,
  caller: Caller,
  document: Artifact,
  lenient: boolean,
): Promise<string | null> {
  try {
    const read = await artifacts.read(caller, document.id);
    return read.encoding === 'utf8' ? read.content : null;
  } catch (error) {
    if (lenient && error instanceof MervError && PERMANENT.has(error.code)) return null;
    throw error;
  }
}
/**
 * Fetches each artifact the input names once, in `tx`, for a render that reads their bytes later.
 * A refusal (a 4xx error such as `not_found`) is kept and thrown where the render asks for that
 * ID, so it fails with the same error, in the same order, as if it fetched each artifact itself.
 * Every ID is still fetched after a refusal, because the render asks in its own order, and a check
 * it makes first (such as `context_missing`) must still win. A transient failure (5xx or not a
 * MervError) is thrown at once, before any of the render's checks: an outage fails the render
 * whatever else is wrong with its input.
 */
async function resolve(
  artifacts: Artifacts,
  caller: Caller,
  input: Omit<ContextBuild, 'requestId'>,
  tx: Transaction,
): Promise<ResolvedArtifacts> {
  const ids = new Set(
    Object.values(input.inputs).flatMap((value) =>
      value.items.flatMap((item) => ('artifactId' in item.body ? [item.body.artifactId] : [])),
    ),
  );
  const found = new Map<string, Artifact | MervError>();
  for (const id of ids) {
    try {
      found.set(id, await artifacts.get(caller, id, tx));
    } catch (error) {
      if (!(error instanceof MervError) || error.status >= 500) throw error;
      found.set(id, error);
    }
  }
  return {
    get: (id) => {
      const artifact = found.get(id)!;
      if (artifact instanceof MervError) throw artifact;
      return artifact;
    },
    read: async (document, lenient) => await readText(artifacts, caller, document, lenient),
  };
}
/**
 * A detached copy of `preview` when it still hashes to `hash`, the hash it was rendered with. A
 * preview changed into something that cannot be copied or hashed is changed too.
 */
function unchanged(preview: ContextPreview, hash: string | undefined): ContextPreview | null {
  if (hash === undefined) return null;
  try {
    const copy = structuredClone(preview);
    const { hash: claimed, ...body } = copy;
    return claimed === hash && digest(body) === hash ? copy : null;
  } catch {
    return null;
  }
}
/** Whether `result` was saved by a format-less version of its type, which a successor replays. */
async function retired(tx: Transaction, result: ContextPackage): Promise<boolean> {
  const row = await tx.get<{ definition: string }>(
    'SELECT definition FROM context_recipes WHERE type=? AND version=? AND hash=?',
    result.type,
    result.typeVersion,
    result.recipeHash,
  );
  return !!row && (JSON.parse(row.definition) as TaskTypeDefinition).recipe.format === undefined;
}

export class RecipeContextBuilder implements ContextBuilder {
  private registrations = new Map<string, symbol>();
  private closed = false;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private artifacts: Artifacts,
  ) {
    this.initialize = async () => {
      await state.migrate('context_builder', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
        {
          version: 2,
          sql: postgresMigrations[2],
        },
        {
          version: 3,
          sql: postgresMigrations[3],
        },
      ]);
    };
  }
  /** Read-only work: in the caller's transaction, else the ambient one, else a read-only snapshot
   *  transaction, which never takes the writer lock. */
  private async reading<T>(
    tx: Transaction | undefined,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    if (tx) {
      this.state.assertTransaction(tx);
      return await fn(tx);
    }
    const ambient = this.state.ambient;
    return ambient
      ? await fn(ambient)
      : await this.state.snapshot(() => this.state.transaction(fn));
  }
  async register(input: TaskTypeDefinition): Promise<ContextRegistration> {
    check(!this.closed, 'context_builder_closed', 'Context Builder is closed', 503);
    const parsed = definitionSchema.safeParse(input);
    check(parsed.success, 'invalid_recipe', 'Invalid context recipe definition');
    // Owner, 2026-09-28: every recipe renders with the item renderer. The rows of format-less
    // versions stay in context_recipes, and their saved packages replay from their successors.
    check(
      parsed.data.recipe.format === 2,
      'recipe_format_retired',
      'Context recipes without format 2 are retired',
    );
    const definition = parsed.data,
      hash = digest(definition),
      key = `${definition.name}@${definition.version}`;
    check(
      new Set(definition.recipe.sections.map((s) => s.key)).size ===
        definition.recipe.sections.length,
      'invalid_recipe',
      'Context section keys must be distinct',
    );
    check(
      !this.registrations.has(key),
      'recipe_registered',
      'Context recipe is already active',
      409,
    );
    // Reserve ownership before storage yields; identical concurrent registrations still
    // belong to different plugins and must never silently replace each other's handles.
    const registration = Symbol(key);
    this.registrations.set(key, registration);
    try {
      const stored = async (sql: Sql) =>
        (
          await sql.get<{ hash: string }>(
            'SELECT hash FROM context_recipes WHERE type=? AND version=?',
            definition.name,
            definition.version,
          )
        )?.hash;
      // A version already stored needs no writer: every boot after the first opens none.
      const pinned =
        (await this.state.read(stored)) ??
        (await this.state.transaction(async (tx) => {
          await tx.run(
            'INSERT INTO context_recipes VALUES(?,?,?,?) ON CONFLICT (type,version) DO NOTHING',
            definition.name,
            definition.version,
            hash,
            JSON.stringify(definition),
          );
          return await stored(tx);
        }));
      check(
        pinned === hash,
        'recipe_changed',
        'Publish a new version to change a context recipe',
        409,
      );
      check(
        !this.closed && this.registrations.get(key) === registration,
        'context_builder_closed',
        'Context Builder closed during recipe registration',
        503,
      );
    } catch (error) {
      if (this.registrations.get(key) === registration) this.registrations.delete(key);
      throw error;
    }
    const live = () =>
      check(
        this.registrations.get(key) === registration,
        'recipe_unavailable',
        'Context recipe is not active',
        503,
      );
    // Every preview this registration returned, with the hash it was rendered with: build saves
    // only these, so a saved package is always one this recipe rendered.
    const rendered = new WeakMap<ContextPreview, string>();
    // The package saved under a request ID. It must be this recipe's, for the same subject.
    const saved = async (
      tx: Transaction,
      caller: Caller,
      requestId: string,
      subject: ContextBuild['subject'],
    ): Promise<ContextPackage | null> => {
      const old = await tx.get<{ package: string }>(
        'SELECT package FROM context_packages WHERE project_id=? AND actor_id=? AND request_id=?',
        caller.projectId,
        caller.actorId,
        requestId,
      );
      if (!old) return null;
      const result = JSON.parse(old.package) as ContextPackage;
      check(
        result.type === definition.name &&
          digest(result.subject) === digest(subject) &&
          ((result.typeVersion === definition.version && result.recipeHash === hash) ||
            (await retired(tx, result))),
        'request_conflict',
        'Context request ID was used for a different assignment or recipe',
        409,
      );
      return result;
    };
    // Each call keeps its own copy of the caller, and parses its input before anything yields:
    // the parsed data is detached, so a caller changing either during authorization changes
    // nothing. Authorization still decides first, so a refused caller never learns more. The
    // builder asks only that the caller may read the project: whether it may do this work or
    // review is its consumer's assignment check, which every consumer makes before rendering.
    return {
      preview: async (caller, input, tx) => {
        live();
        caller = structuredClone(caller);
        const parsed = previewSchema.safeParse(input);
        // Authorization and metadata are read here. Bytes are read after it returns, so outside
        // a transaction they are read once its snapshot has closed.
        const { request, artifacts } = await this.reading(tx, async (tx) => {
          await this.scope.require(caller, 'read', tx);
          check(
            parsed.success,
            'invalid_context',
            'Context preview needs a subject and structured inputs',
          );
          return {
            request: parsed.data,
            artifacts: await resolve(this.artifacts, caller, parsed.data, tx),
          };
        });
        const result = await renderItems(definition, hash, caller, request, artifacts);
        rendered.set(result, result.hash);
        return result;
      },
      build: async (caller, input, transaction) => {
        live();
        caller = structuredClone(caller);
        const parsed = saveSchema.safeParse(input);
        // Copied before anything yields, and hashed again: a copy of a preview, or one changed
        // since it was rendered, is refused.
        const preview = parsed.success
          ? unchanged(parsed.data.preview, rendered.get(parsed.data.preview))
          : null;
        return await inTransaction(this.state, transaction, async (tx) => {
          await this.scope.require(caller, 'read', tx);
          check(
            parsed.success,
            'invalid_context',
            'Context build needs a request ID and a preview',
          );
          check(
            preview,
            'invalid_context',
            'Build saves an unchanged preview this recipe rendered',
          );
          check(
            preview.projectId === caller.projectId && preview.actorId === caller.actorId,
            'invalid_context',
            'Build saves a preview rendered for its caller',
          );
          const { requestId } = parsed.data;
          const old = await saved(tx, caller, requestId, preview.subject);
          if (old) return old;
          const result: ContextPackage = { ...preview, id: newId('context'), createdAt: now() };
          await tx.run(
            'INSERT INTO context_packages VALUES(?,?,?,?,?,?)',
            result.id,
            caller.projectId,
            caller.actorId,
            requestId,
            result.hash,
            JSON.stringify(result),
          );
          await recorded(this.state, tx, caller, 'context.built', result.id, {
            type: definition.name,
            typeVersion: definition.version,
            subjectId: result.subject.id,
            hash: result.hash,
          });
          return result;
        });
      },
      replay: async (caller, input, tx) => {
        live();
        caller = structuredClone(caller);
        const parsed = replaySchema.safeParse(input);
        return await this.reading(tx, async (tx) => {
          await this.scope.require(caller, 'read', tx);
          check(parsed.success, 'invalid_context', 'Context replay needs a subject and request ID');
          return await saved(tx, caller, parsed.data.requestId, parsed.data.subject);
        });
      },
      dispose: () => {
        if (this.registrations.get(key) === registration) this.registrations.delete(key);
      },
    };
  }
  close(): void {
    this.closed = true;
    this.registrations.clear();
  }
}
export const contextBuilderPlugin = {
  name: 'merv-context-builder',
  inject: ['state', 'scope', 'artifacts'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const builder = await createService(
        new RecipeContextBuilder(ctx.state, ctx.scope, ctx.artifacts),
      );
      yield () => builder.close();
      yield ctx.provide('contextBuilder', builder);
    });
  },
};
export default contextBuilderPlugin;
