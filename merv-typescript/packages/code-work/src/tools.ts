import type { NounActions } from '@merv/api/types';
import { type Caller, type CodeCommandRecord, idSchema } from '@merv/contracts';
import { codeUnitFenceInputSchema } from '@merv/code/store/protocol';
import type { Context } from 'cordis';
import { z } from 'zod';
import { baseControlSchema } from './bases.js';
import { repositoryPrepareSchema } from './repository-setup.js';
import { codeRepositoryConfigureInputSchema } from './check-configuration.js';
import { codePublicationIdSchema } from './publications.js';

/** Runner refusals carry only codes; explain limits and recovery without exposing content. */
const REFUSALS: Record<string, string> = {
  workspace_file_too_large:
    'Code keeps no file over 50 MiB, and a new or changed file in the checkout that is not ignored is larger. List the large files with `find . -path ./.git -prune -o -type f -size +50M -print`; each one `git check-ignore` does not name must be ignored in .gitignore or removed (retain data you need with artifact.upload_begin). Then commit again with a new requestId.',
  code_capture_quarantined:
    'Code refused the commit because a file in it matches a credential pattern. code.status lists the refused upload under operations, with the path and rule of each finding but never the text. A real credential must leave the checkout: remove it and commit again with a new requestId. Data that only looks like one (public datasets, fixtures) stays out of Git (retain it with artifact.upload_begin) unless a project administrator exempts its paths with secretExemptGlobs in code.repository.configure; ask with session.ask_owner.',
  workspace_foreign_path:
    'A new or changed path in the checkout lies under a symbolic link that leads outside it. Replace the link with the files themselves or remove it, then commit again with a new requestId.',
};

/** Omit stale attachment head/stats; the receipt carries the commit's own. */
const attached = async (record: Promise<CodeCommandRecord>) => {
  const { command, ...rest } = await record;
  const { headOid: _head, stats: _stats, ...workspace } = command.workspace;
  const next = rest.error ? REFUSALS[rest.error] : undefined;
  return { ...rest, ...(next ? { next } : {}), command: { ...command, workspace } };
};

/** The fields a script relies on in each read, as passthrough objects: never validators. */
const output = (shape: z.ZodRawShape) => z.object(shape).passthrough();
const commandOutput = output({
  status: z.string(),
  error: z.string().nullable(),
  command: output({ id: z.string(), expectedHead: z.string() }),
  receipt: output({}).nullable(),
});
const outputs = {
  files: output({
    ref: z.string(),
    commit: z.string(),
    path: z.string(),
    kind: z.enum(['folder', 'file']),
    entries: z
      .array(z.object({ name: z.string(), kind: z.string(), size: z.number().optional() }))
      .optional(),
    text: z.string().optional(),
    withheld: z.enum(['too_large', 'binary']).optional(),
  }),
  log: output({
    ref: z.string(),
    commit: z.string(),
    commits: z.array(
      output({
        oid: z.string(),
        parents: z.array(z.string()),
        date: z.string(),
        subject: z.string(),
        unit: z.object({ id: z.string(), kind: z.string(), title: z.string() }).optional(),
      }),
    ),
  }),
  status: output({
    project: output({}).nullable(),
    bases: z.array(output({ key: z.string() })),
    units: z.array(output({})),
    blockers: z.array(output({})),
    operations: z.array(output({})),
    warnings: z.array(z.unknown()),
  }),
  unit: output({
    unitId: z.string().optional(),
    canonicalHead: z.string().nullable().optional(),
    acceptance: output({}).nullable(),
  }),
  operation: commandOutput,
};

const browseInput = z.strictObject({
  ref: z.string().trim().max(200).optional(),
  path: z.string().max(4096).optional(),
});

const reads = (ctx: Context): NounActions => ({
  files: {
    summary:
      'Read Code’s repository at ref: main (default), task/experiment ID (accepted code, else latest admitted commit), or full commit ID. Omit path for root; folders list folders first, then files with byte sizes. Files return text up to 1 MiB; larger/binary files are flagged.',
    description:
      "Read the project's code as files, the way a repository browser shows files: with no path, the root folder; a path names a folder (its entries: folders first, then files with their bytes) or a file (its text, up to 1 MiB; binary and larger files say so instead). ref chooses whose code: main (the default), a task or experiment by its work unit id (its accepted code, or else the newest commit Code admitted for it), or a full commit id. It reads Code's own repository and changes nothing.",
    input: browseInput,
    output: outputs.files,
    was: ['code.files'],
    handler: (caller, input) => ctx.codeWork.files(caller, input),
  },
  log: {
    summary:
      'Git history newest first, with message, parents/date and unit id/kind/title. ref: main (default), task/experiment ID or full commit ID; path filters changed files/folders; limit default 50, max 200.',
    description:
      "Read the project's Git history newest first, like git log, with the task or experiment each commit came from (unit: its id, kind and title) — Git itself does not carry those names. ref chooses whose history: main (the default), a task or experiment by its work unit id, or a full commit id; path narrows it to commits that changed that file or folder; limit is at most 200 (default 50). Each commit has its subject, its bullet-point body, parents and date. It changes nothing.",
    input: browseInput.extend({ limit: z.number().int().min(1).max(200).optional() }),
    output: outputs.log,
    was: ['code.log'],
    handler: (caller, input) => ctx.codeWork.history(caller, input),
  },
  status: {
    summary:
      'Read retained bases, repository binding, units, storage, operations and recovery blockers. code.base.retry retries a failed base. Local integration is asynchronous; source branch pushes do not advance the research baseline.',
    description:
      'Read the project repository binding, work units, retained base pins, project checks, admission limits and pending operations. Each blocker names the recovery action; code.base.retry retries a failed base. Local integrations retain independent review and accepted history.',
    input: z.object({}).strict(),
    output: outputs.status,
    was: ['code.status'],
    handler: (caller) => ctx.codeWork.status(caller),
  },
  unit: {
    summary:
      'Read unit’s base/dependencies, exact reviewed acceptance and reviewer checkout attachment, writer generation/state, canonicalHead (resume point). storage code means retained code; receipt identifies its operation; none means no accepted code. Quarantined capture findings: code.status; code.unit.fence resolves them.',
    description:
      'Read what Code holds about one unit of work, named by its work unit id: the base it was pinned to with the accepted dependencies that base came from, and its acceptance with the exact reviewed code, the submission and review it names, and whether the reviewer’s checkout was attached at that code. storage code means Code’s own repository holds the accepted code, and receipt names the operation that made it durable; none means the unit was accepted without code. For a unit that lives in Code’s repository it also gives the writer: generation, the number of leased sessions that have written to it; writerState (reserved, active, closing while an upload its session had in flight when it closed, or the final capture of a worker that ended its own visit, finishes within the grace, closed, or recovery_required while a quarantined capture waits for code.unit.fence); canonicalHead, the newest commit Code admitted, which is what the next session on any machine resumes from; quarantine, the final capture Code refused, whose findings code.status lists and which code.unit.fence resolves.',
    input: z.object({ unitId: idSchema }).strict(),
    output: outputs.unit,
    was: ['code.unit.get'],
    handler: (caller, input) => ctx.codeWork.unit(caller, input.unitId),
  },
  operation: {
    description:
      'Inspect a retained historical code operation and its immutable receipt by operation id. Current work uses ordinary Git and frozen submissions. A leased worker reads the operations of its own unit of work, its reviewer included. A succeeded receipt identifies the exact committed head, tree, parent and stats; command.workspace only names the checkout. It does not authorize central publication.',
    input: z.object({ commandId: idSchema }).strict(),
    output: outputs.operation,
    was: ['code.operation'],
    handler: (caller, input) => attached(ctx.codeWork.operation(caller, input.commandId)),
  },
});

/** The seven base controls, each keeping its retired name's flat body for its request digest. */
const BASES = [
  ['retry', 'Retry infrastructure work on this same base with five new attempts.'],
  ['suspend', 'Suspend this base while retaining its current work and history.'],
  [
    'resume',
    'Resume a suspended base in its prior work state. A suspended resolution task resumes as its blocker’s next move says.',
  ],
  ['cancel', 'Cancel this unresolved base permanently. Replan its waiters with corrective work.'],
  [
    'quarantine',
    'Quarantine this base and its descendants, including existing pins and acceptances. Its immutable result stays retained and cannot be reused; create corrective work and replan.',
  ],
  [
    'release',
    'Release this base from quarantine after verifying the alarm was false. Every base and unit that only inherited the quarantine from it is released with it; a base quarantined in its own right keeps its own reach. A writer generation the quarantine had put into recovery_required ends at its last admitted commit on Code’s next sweep. Name the verification in reason.',
  ],
  [
    'repair',
    'Drop the Git ref an interrupted execution of this base left behind, so the next attempt can settle. Use it when this base reports that its ref names another commit. Refused for a base that is running, quarantined, or whose result is already sealed, because a sealed result is what everything pinned to it names. The receipt retains the commit that was dropped.',
  ],
] as const;

const writes = (ctx: Context): NounActions => ({
  ...Object.fromEntries(
    BASES.map(([action, instruction]) => [
      `base_${action}`,
      {
        summary:
          action === 'release'
            ? 'Release a verified false-alarm quarantine, naming verification in reason. Releases inherited quarantines, not independently quarantined bases. Recovery-required writers end at last admitted commit on next sweep.'
            : action === 'repair'
              ? 'Drop an interrupted base’s mismatched Git ref so retry can settle; receipt retains dropped commit. Refuses running/quarantined/sealed bases.'
              : instruction,
        description: `${instruction} Supply the key from code.status, a reason and a stable requestId. Only a project administrator or their agent may call it, never a leased worker.`,
        input: baseControlSchema.omit({ action: true }),
        was: [`code.base.${action}`],
        handler: async (caller, input) => ctx.codeWork.controlBase(caller, { ...input, action }),
      },
    ]),
  ),
  unit_fence: {
    summary:
      'End a quarantined final-capture writer (code_capture_quarantined); inspect code.status findings first. Admin only, no leased worker; stable requestId. Closes at the last admitted commit; pending data stays on disk, unadmitted; next lease starts a new generation there. Refuses code_fence_unneeded without quarantine, or code_operation_unresolved during an admitted upload. Other writers close automatically.',
    description:
      'End the writer generation of a unit whose final capture is quarantined (code_capture_quarantined; read the findings in code.status first): every other writer generation ends by itself with its session. Refused with code_fence_unneeded for a unit no quarantined capture holds. The unit closes at the last commit Code admitted, anything the old generation was still sending is kept on the server’s disk and never admitted, and the next lease continues from that commit as the next generation. Refused with code_operation_unresolved while an admitted upload of the unit is unfinished. Only a project administrator or their agent may call it, never a leased worker. Supply a stable requestId.',
    input: codeUnitFenceInputSchema,
    was: ['code.unit.fence'],
    handler: (caller, input) => ctx.codeWork.fenceUnit(caller, input),
  },
  repository_configure: {
    summary:
      'Admin; stable requestId. Replace denyGlobs and secretExemptGlobs (skip fixture credential checks). Root-relative globs: literals, ? one character, * within segment, ** across segments. Always give check:null (off) or command/timeoutSeconds/image (provider/offerId/optional snapshotId). Runs rented writable merged tree with network, no Merv credentials/environment; verdict records this. Failure creates reviewed conflict-resolution task; missing sandbox connection leaves bases unsealed with code_check_unavailable.',
    description:
      'Set what this project’s repository refuses beyond the fixed limits, and the one command that proves a merged base works. denyGlobs are paths no admitted history may contain; secretExemptGlobs are paths the credential patterns skip, for fixtures that are shaped like tokens. A glob is matched against the whole path from the repository root: a literal matches itself, ? one character and * any run within one segment, ** any run across segments. Both lists replace what was set. check is the project check and must be stated on every call: null turns verification off, and an object gives command, timeoutSeconds and image (provider, offerId and an optional snapshotId). The command runs against the merged tree in a machine this server rents for the occasion and never on this server; it is given no Merv credential and no environment, the machine has network access and a writable copy of the source, and every base record says so beside its verdict. A failing check is treated as a conflict and resolved by the one reviewed task a Git conflict is resolved by. Without a sandbox connection a configured command leaves each base unsealed and blocked with code_check_unavailable for an operator. Only a project administrator may call it. Supply a stable requestId.',
    input: codeRepositoryConfigureInputSchema,
    was: ['code.repository.configure'],
    handler: (caller, input) => ctx.codeWork.configureRepository(caller, input),
  },
  repository_prepare: {
    summary:
      'Admin/agent: integrate a source branch already pushed to Merv. Pin its exact head and current research main; an independent integration review preserves both histories.',
    description:
      'Select baseBranch, headOid and expectedMainOid from the retained project remote. New source history opens one independently reviewed integration task. Retry identical inputs after acceptance to advance the baseline by compare-and-swap. Running work keeps its original pins.',
    input: repositoryPrepareSchema,
    was: ['code.repository.prepare'],
    handler: (caller, input) => ctx.codeWork.prepareRepository(caller, input),
  },
  publication_sync: {
    description:
      'Reconcile reviewed integrations and advance the local research baseline after verifying the accepted content and ancestry. Requires project write authority and refuses leased workers.',
    input: z.object({}).strict(),
    was: ['code.publication.sync'],
    handler: (caller) => ctx.codeWork.syncPublications(caller),
  },
});

export const codeToolsPlugin = {
  name: 'merv-code-tools',
  inject: ['codeWork', 'tools'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.tools.noun('code.read', {
        tier: 'core',
        readOnly: true,
        summary: 'Read repository files, history and Code state.',
        description:
          "Read the project's code and Code's records: files (a folder or file at a ref, at an exact revision), log (history newest first, each commit with its work unit), status (bases, binding, units, blockers, store, transfers), unit (what Code holds about one work unit) and operation (a retained operation and its receipt). It changes nothing.",
        actions: reads(ctx),
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('code.write', {
        summary:
          'Admin/agent repository controls; no leased workers. Base controls take key from code.status, reason and stable requestId. repository_prepare alone moves main to outside history.',
        description:
          "Change how Code keeps this project's repository; a project administrator or their agent, never a leased worker. base_retry … base_repair control a base by its key from code.read status; unit_fence; repository_configure and repository_prepare (the only way main moves to outside history); publication_sync.",
        actions: writes(ctx),
        // Historical bind names point to reviewed integration of an already pushed branch.
        removed: {
          'code.local.bind': 'repository_prepare',
          'code.repository.rebind': 'repository_prepare',
        },
      }),
    );
    const definitions = [
      {
        name: 'code.publication.read',
        tier: 'ui' as const,
        description:
          'Read retained local integration and historical publication evidence. No external service is contacted.',
        inputSchema: codePublicationIdSchema,
        readOnly: true,
        handler: (caller: Caller, input: { proposalId: string }) =>
          ctx.codeWork.publicationDetails(caller, input.proposalId),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default codeToolsPlugin;
