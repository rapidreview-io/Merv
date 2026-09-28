import { clip, visible, recorded, mapAsync } from '@merv/contracts';
import { createService } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { render, type ResolvedArtifacts } from './legacy.js';
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
  type Sql,
  type Transaction,
  type Artifact,
} from '@merv/contracts';

const identifier = z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/);
const rankedItem = z
  .object({
    id: z.string().trim().min(1).max(300),
    // Clipped, not rejected: a long section title must not fail every build that lists it.
    title: z
      .string()
      .trim()
      .min(1)
      .transform((title) => clip(title, 300)),
    priority: z.number().int().min(-1_000_000).max(1_000_000),
    content: z.union([
      z.object({ text: z.string() }).strict(),
      z.object({ artifactId: z.string().min(1) }).strict(),
    ]),
    revision: z.number().int().nonnegative().optional(),
    hash: z.string().min(1).max(200).optional(),
    association: z.string().trim().min(1).max(500).optional(),
    refs: z
      .array(
        z
          .object({
            tool: identifier,
            input: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
          })
          .strict(),
      )
      .min(1)
      .max(8),
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
    inputs: z.record(
      z.union([
        z.object({ text: z.string() }).strict(),
        z.object({ rankedItems: z.array(rankedItem) }).strict(),
        z
          .object({
            artifactIds: z.array(z.string().min(1)),
            mode: z.enum(['text', 'auto', 'references']).optional(),
          })
          .strict(),
      ]),
    ),
    requestId: z.string().trim().min(1).max(200).refine(visible),
  })
  .strict();
const previewSchema = buildSchema.omit({ requestId: true });
const replaySchema = buildSchema.omit({ inputs: true });

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
 */
async function resolve(
  artifacts: Artifacts,
  caller: Caller,
  input: Omit<ContextBuild, 'requestId'>,
  tx: Transaction,
): Promise<ResolvedArtifacts> {
  const ids = new Set(
    Object.values(input.inputs).flatMap((value) =>
      'artifactIds' in value
        ? value.artifactIds
        : 'rankedItems' in value
          ? value.rankedItems.flatMap((item) =>
              'artifactId' in item.content ? [item.content.artifactId] : [],
            )
          : [],
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
/** Media types whose bytes are worth reading as text. */
export const textual = (mediaType: string) =>
  mediaType.startsWith('text/') || mediaType === 'application/json';
/** The fewest UTF-16 units `bytes` of UTF-8 can decode to: a unit is at most 3 bytes. */
export const minChars = (bytes: number) => Math.ceil(bytes / 3);
/** A caller string on one line, so it can never start a structural line such as a heading. */
export const line = (text: string) => text.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');
/** A source as the package records it: exactly the artifact schema's fields, whatever `get` returned. */
export const source = ({
  id,
  projectId,
  createdBy,
  title,
  mediaType,
  hash,
  size,
  objectId,
  createdAt,
}: Artifact): Artifact => ({
  id,
  projectId,
  createdBy,
  title,
  mediaType,
  hash,
  size,
  ...(objectId === undefined ? {} : { objectId }),
  createdAt,
});

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
    const definition = parsed.data,
      hash = digest(definition),
      key = `${definition.name}@${definition.version}`,
      role = definition.kind === 'review' ? 'review' : 'write';
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
    // Each call keeps its own copy of the caller, and parses its input before anything yields:
    // the parsed data is detached, so a caller changing either during authorization changes
    // nothing. Authorization still decides first, so a refused caller never learns more.
    return {
      preview: async (caller, input, tx) => {
        live();
        caller = structuredClone(caller);
        const parsed = previewSchema.safeParse(input);
        // Authorization and metadata are read here. Bytes are read after it returns, so outside
        // a transaction they are read once its snapshot has closed.
        const { request, artifacts } = await this.reading(tx, async (tx) => {
          await this.scope.require(caller, role, tx);
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
        return await render(definition, hash, caller, request, artifacts);
      },
      build: async (caller, input, transaction) => {
        live();
        caller = structuredClone(caller);
        const parsed = buildSchema.safeParse(input);
        return await inTransaction(this.state, transaction, async (tx) => {
          await this.scope.require(caller, role, tx);
          check(
            parsed.success,
            'invalid_context',
            'Context needs a subject, structured inputs and request ID',
          );
          const request = parsed.data;
          const inputHash = digest({
            definition,
            subject: request.subject,
            inputs: request.inputs,
          });
          const old = await tx.get<{ input_hash: string; package: string }>(
            'SELECT input_hash,package FROM context_packages WHERE project_id=? AND actor_id=? AND request_id=?',
            caller.projectId,
            caller.actorId,
            request.requestId,
          );
          if (old) {
            check(
              old.input_hash === inputHash,
              'request_conflict',
              'Context request ID was used with different input',
              409,
            );
            return JSON.parse(old.package);
          }
          const artifacts = await resolve(this.artifacts, caller, request, tx);
          const result: ContextPackage = {
            ...(await render(definition, hash, caller, request, artifacts)),
            id: newId('context'),
            createdAt: now(),
          };
          await tx.run(
            'INSERT INTO context_packages VALUES(?,?,?,?,?,?)',
            result.id,
            caller.projectId,
            caller.actorId,
            request.requestId,
            inputHash,
            JSON.stringify(result),
          );
          await recorded(this.state, tx, caller, 'context.built', result.id, {
            type: definition.name,
            typeVersion: definition.version,
            subjectId: request.subject.id,
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
          await this.scope.require(caller, role, tx);
          check(parsed.success, 'invalid_context', 'Context replay needs a subject and request ID');
          const old = await tx.get<{ package: string }>(
            'SELECT package FROM context_packages WHERE project_id=? AND actor_id=? AND request_id=?',
            caller.projectId,
            caller.actorId,
            parsed.data.requestId,
          );
          if (!old) return null;
          const result = JSON.parse(old.package) as ContextPackage;
          check(
            result.type === definition.name &&
              result.typeVersion === definition.version &&
              result.recipeHash === hash &&
              digest(result.subject) === digest(parsed.data.subject),
            'request_conflict',
            'Context request ID was used for a different assignment or recipe',
            409,
          );
          return result;
        });
      },
      dispose: () => {
        if (this.registrations.get(key) === registration) this.registrations.delete(key);
      },
    };
  }
  async mode(
    caller: Caller,
    ids: string[],
    room: number,
    tx: Transaction,
  ): Promise<'auto' | 'references'> {
    check(!this.closed, 'context_builder_closed', 'Context Builder is closed', 503);
    caller = structuredClone(caller);
    ids = [...ids];
    const documents = await mapAsync(ids, async (id) => await this.artifacts.get(caller, id, tx));
    const inline = documents.filter((a) => textual(a.mediaType)).reduce((n, a) => n + a.size, 0);
    return inline > room ? 'references' : 'auto';
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
