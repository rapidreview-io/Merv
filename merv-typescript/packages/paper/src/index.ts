import { recorded, mapAsync } from '@merv/contracts';
import { createService, replayed } from '@merv/contracts';
import type { Context } from 'cordis';
import {
  check,
  digest,
  inTransaction,
  newId,
  now,
  type Artifacts,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type {
  Paper,
  PaperCitation,
  PaperCite,
  PaperKind,
  PaperPatch,
  PaperPublication,
  PaperRevision,
  PaperWorkspace,
  PaperProposal,
  PaperPropose,
  PaperAccept,
  PaperEdit,
} from './types.js';
import { citeSchema, kind, parse, patchSchema, changesSchema, proposeSchema } from './input.js';
import { migratePaper } from './storage.js';
export type * from './types.js';
const kinds: PaperKind[] = ['problem', 'literature', 'methods', 'results'];
const problemKeys = ['problem', 'scope', 'goals', 'constraints'];
const unique = (values: string[]) => [...new Set(values)].sort();

/** A document store. Scientific workflow owners stage and accept edits in their own review transaction. */
export class PaperService implements Paper {
  private closed = false;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private artifacts: Artifacts,
  ) {
    this.initialize = async () => {
      await migratePaper(state);
    };
  }
  close(): void {
    this.closed = true;
  }
  private open(): void {
    check(!this.closed, 'paper_unavailable', 'Living paper is unavailable', 503);
  }
  private async current(
    caller: Caller,
    documentKind: PaperKind,
    tx: Transaction,
  ): Promise<PaperRevision> {
    const row = await tx.get<{ record: string }>(
      'SELECT record FROM paper_revisions WHERE project_id=? AND kind=? ORDER BY revision DESC LIMIT 1',
      caller.projectId,
      documentKind,
    );
    return row
      ? (JSON.parse(row.record) as PaperRevision)
      : {
          projectId: caller.projectId,
          kind: documentKind,
          revision: 0,
          sections:
            documentKind === 'problem'
              ? problemKeys.map((id) => ({
                  id,
                  title: id[0].toUpperCase() + id.slice(1),
                  content: '',
                }))
              : [],
          updatedBy: null,
          updatedAt: null,
          updateId: null,
        };
  }
  private async citations(caller: Caller, tx: Transaction): Promise<PaperCitation[]> {
    return (
      await tx.all<{ record: string }>(
        `SELECT c.record FROM paper_citations c WHERE c.project_id=? AND c.revision=(SELECT MAX(p.revision) FROM paper_citations p WHERE p.id=c.id) ORDER BY c.identifier,c.id`,
        caller.projectId,
      )
    ).map((row) => JSON.parse(row.record));
  }
  async read(caller: Caller, transaction?: Transaction): Promise<PaperWorkspace> {
    this.open();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const documents = Object.fromEntries(
        await mapAsync(kinds, async (documentKind) => {
          const current = await this.current(caller, documentKind, tx);
          const row = await tx.get<{ record: string }>(
            tx.dialect === 'postgres'
              ? 'SELECT record FROM paper_publications WHERE project_id=? AND kind=? ORDER BY _merv_rowid DESC LIMIT 1'
              : 'SELECT record FROM paper_publications WHERE project_id=? AND kind=? ORDER BY rowid DESC LIMIT 1',
            caller.projectId,
            documentKind,
          );
          const publication = row ? (JSON.parse(row.record) as PaperPublication) : null;
          const document = publication
            ? (await this.history(caller, documentKind, tx)).find(
                (r) => r.revision === publication.revision,
              )!
            : null;
          return [
            documentKind,
            { current, published: publication && document ? { publication, document } : null },
          ];
        }),
      ) as PaperWorkspace['documents'];
      const proposals = (
        await tx.all<{ record: string; acceptance: string | null }>(
          tx.dialect === 'postgres'
            ? 'SELECT record,acceptance FROM paper_proposals WHERE project_id=? ORDER BY _merv_rowid DESC'
            : 'SELECT record,acceptance FROM paper_proposals WHERE project_id=? ORDER BY rowid DESC',
          caller.projectId,
        )
      ).map((row) => ({
        ...JSON.parse(row.record),
        acceptance: row.acceptance ? JSON.parse(row.acceptance) : null,
      }));
      return { documents, citations: await this.citations(caller, tx), proposals };
    });
  }
  async history(
    caller: Caller,
    documentKind: PaperKind,
    transaction?: Transaction,
  ): Promise<PaperRevision[]> {
    this.open();
    parse(kind, documentKind);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (
        await tx.all<{ record: string }>(
          'SELECT record FROM paper_revisions WHERE project_id=? AND kind=? ORDER BY revision',
          caller.projectId,
          documentKind,
        )
      ).map((row) => JSON.parse(row.record));
    });
  }
  private async command<T>(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    tx: Transaction,
    execute: () => T | Promise<T>,
  ): Promise<T> {
    return await replayed(tx, 'paper_commands', caller, operation, input, execute, {
      result: 'result_json',
      after: async () => await this.scope.require(caller, 'write', tx),
    });
  }
  private async revision(
    caller: Caller,
    before: PaperRevision,
    after: PaperRevision,
    tx: Transaction,
  ): Promise<void> {
    check(
      after.revision === before.revision + 1 && Number.isSafeInteger(after.revision),
      'paper_revision_conflict',
      'Document revision is exhausted',
      409,
    );
    await tx.run(
      'INSERT INTO paper_revisions VALUES(?,?,?,?)',
      caller.projectId,
      after.kind,
      after.revision,
      JSON.stringify(after),
    );
    await recorded(this.state, tx, caller, 'paper.patched', `${after.kind}:${after.revision}`, {
      kind: after.kind,
      revision: after.revision,
      updateId: after.updateId,
    });
  }
  /**
   * A proposal written against an older revision still applies when the sections it touches,
   * and the anchors it inserts after, are unchanged since; otherwise its author must rewrite it.
   */
  private async rebased(
    caller: Caller,
    edit: PaperEdit,
    before: PaperRevision,
    tx: Transaction,
  ): Promise<PaperEdit> {
    if (edit.expectedRevision === before.revision) return edit;
    const row = await tx.get<{ record: string }>(
      'SELECT record FROM paper_revisions WHERE project_id=? AND kind=? AND revision=?',
      caller.projectId,
      edit.kind,
      edit.expectedRevision,
    );
    const then = row ? (JSON.parse(row.record) as PaperRevision).sections : [];
    const same = (id: string) =>
      digest(then.find((s) => s.id === id) ?? null) ===
      digest(before.sections.find((s) => s.id === id) ?? null);
    check(
      edit.changes.every((c) => same(c.id) && (c.afterId == null || same(c.afterId))),
      'paper_revision_conflict',
      `The proposed ${edit.kind} edits overlap changes accepted since revision ${edit.expectedRevision}; return the work for a proposal against revision ${before.revision}`,
      409,
    );
    return { ...edit, expectedRevision: before.revision };
  }
  private async edited(
    caller: Caller,
    input: PaperEdit | PaperPatch,
    before: PaperRevision,
    tx: Transaction,
  ): Promise<PaperRevision> {
    check(
      before.revision === input.expectedRevision,
      'paper_revision_conflict',
      `Expected revision ${input.expectedRevision}, found ${before.revision}; work against the current one`,
      409,
    );
    const sections = structuredClone(before.sections);
    check(
      new Set(input.changes.map((c) => c.id)).size === input.changes.length,
      'invalid_paper_input',
      'A section may occur once per patch',
    );
    for (const change of input.changes) {
      if (input.kind === 'problem')
        check(
          problemKeys.includes(change.id) && !change.remove && change.afterId === undefined,
          'invalid_paper_input',
          'Problem sections are problem, scope, goals, constraints in that order',
        );
      const index = sections.findIndex((s) => s.id === change.id);
      if (change.remove) {
        check(
          index >= 0 &&
            change.title === undefined &&
            change.content === undefined &&
            change.afterId === undefined,
          'invalid_paper_input',
          'Remove must name one existing section without other changes',
        );
        check(
          input.kind !== 'literature' ||
            !(await this.citations(caller, tx)).some((c) => c.sectionIds.includes(change.id)),
          'paper_section_referenced',
          'Move citations before removing their literature section',
          409,
        );
        sections.splice(index, 1);
        continue;
      }
      check(
        change.title !== undefined || change.content !== undefined || change.afterId !== undefined,
        'invalid_paper_input',
        'Specify a section change',
      );
      check(
        index >= 0 || (change.title !== undefined && change.content !== undefined),
        'invalid_paper_input',
        'New sections need title and content',
      );
      const section = {
        id: change.id,
        title: change.title ?? sections[index]?.title,
        content: change.content ?? sections[index]?.content,
      };
      if (index >= 0) sections[index] = section;
      else sections.push(section);
      if (change.afterId !== undefined) {
        check(
          change.afterId !== change.id,
          'invalid_paper_input',
          'A section cannot follow itself',
        );
        sections.splice(
          sections.findIndex((s) => s.id === change.id),
          1,
        );
        const after =
          change.afterId === null ? -1 : sections.findIndex((s) => s.id === change.afterId);
        check(
          change.afterId === null || after >= 0,
          'invalid_paper_input',
          'afterId must identify an existing section',
        );
        sections.splice(after + 1, 0, section);
      }
    }
    check(
      sections.length <= 100 && sections.reduce((sum, s) => sum + s.content.length, 0) <= 160_000,
      'paper_too_large',
      'Paper document exceeds 100 sections or 160,000 characters',
    );
    return {
      ...before,
      revision: before.revision + 1,
      sections,
      updatedBy: caller.actorId,
      updatedAt: now(),
      updateId: null,
    };
  }
  async patch(
    caller: Caller,
    value: PaperPatch,
    transaction?: Transaction,
  ): Promise<PaperRevision> {
    this.open();
    const input = parse(patchSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      check(
        !caller.session,
        'forbidden',
        'Assigned agents submit paper edits through their experiment or reflection',
        403,
      );
      check(
        input.kind === 'problem' || input.kind === 'literature',
        'paper_review_required',
        'Methods and Results changes belong to an experiment or reflection review',
        409,
      );
      return await this.command(caller, 'patch', input, tx, async () => {
        const before = await this.current(caller, input.kind, tx);
        const after = await this.edited(caller, input, before, tx);
        await this.revision(caller, before, after, tx);
        return after;
      });
    });
  }
  async cite(caller: Caller, value: PaperCite, transaction?: Transaction): Promise<PaperCitation> {
    this.open();
    const input = parse(citeSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'cite', input, tx, async () => {
        const citations = await this.citations(caller, tx);
        const before = input.id ? citations.find((c) => c.id === input.id) : undefined;
        check(
          !input.id || before,
          'paper_citation_not_found',
          'Citation not found in this project',
          404,
        );
        check(
          (before?.revision ?? 0) === input.expectedRevision,
          'paper_revision_conflict',
          'Read the citation revision before updating',
          409,
        );
        const identifier = input.identifier.toLowerCase();
        check(
          !citations.some((c) => c.identifier === identifier && c.id !== before?.id),
          'paper_citation_exists',
          'Update the existing ledger entry for this identifier',
          409,
        );
        const sections = (await this.current(caller, 'literature', tx)).sections;
        check(
          input.sectionIds.every((id) => sections.some((s) => s.id === id)),
          'paper_section_not_found',
          'Citations must reference existing literature sections',
          404,
        );
        const refs = await mapAsync(input.refs, async (ref) => {
          // Preserve historical research links without looking up another domain's records.
          if (before?.refs.includes(ref)) return ref;
          check(
            ref.startsWith('artifact:'),
            'paper_reference_invalid',
            'New citation refs name retained artifact:<id> evidence; scientific source links are retained with reviewed contributions',
          );
          const artifact = await this.artifacts.get(caller, ref.slice(9), tx);
          return `artifact:${artifact.id}`;
        });
        const timestamp = now();
        const citation: PaperCitation = {
          id: before?.id ?? newId('citation'),
          projectId: caller.projectId,
          revision: (before?.revision ?? 0) + 1,
          identifier,
          title: input.title,
          authors: input.authors,
          year: input.year,
          url: input.url,
          notes: input.notes,
          sectionIds: unique(input.sectionIds),
          refs: unique(refs),
          createdAt: before?.createdAt ?? timestamp,
          updatedAt: timestamp,
          updatedBy: caller.actorId,
        };
        await tx.run(
          'INSERT INTO paper_citations VALUES(?,?,?,?,?)',
          citation.id,
          caller.projectId,
          citation.revision,
          identifier,
          JSON.stringify(citation),
        );
        await recorded(this.state, tx, caller, 'paper.cited', citation.id, {
          revision: citation.revision,
          identifier,
        });
        return citation;
      });
    });
  }
  async propose(caller: Caller, value: PaperPropose, tx: Transaction): Promise<PaperProposal> {
    this.open();
    this.state.assertTransaction(tx);
    await this.scope.require(caller, 'write', tx);
    const input = parse(proposeSchema, value);
    const artifact = await this.artifacts.get(caller, input.artifactId, tx);
    const authored = caller.session
      ? (await this.artifacts.authored(caller, tx)).some((a) => a.id === artifact.id)
      : artifact.createdBy === caller.actorId;
    check(
      authored,
      'invalid_evidence_author',
      'Paper edits must be authored by the current producer',
      403,
    );
    const retained = await this.artifacts.read(caller, artifact.id);
    check(
      Buffer.byteLength(retained.content) <= 400000,
      'paper_too_large',
      'Paper change artifact is too large',
    );
    check(retained.encoding === 'utf8', 'invalid_paper_input', 'Paper changes must be UTF-8 JSON');
    let json: unknown;
    try {
      json = JSON.parse(retained.content);
    } catch {
      check(false, 'invalid_paper_input', 'Paper changes must be a UTF-8 JSON artifact');
    }
    // Text reaching the paper through an artifact obeys the rule every direct write does.
    const changes = parse(changesSchema, json);
    check(
      new Set(changes.documents.map((d) => d.kind)).size === changes.documents.length,
      'invalid_paper_input',
      'Each document occurs once per proposal',
    );
    const documents = await mapAsync(changes.documents, async (edit) => ({
      edit,
      before: await this.current(caller, edit.kind, tx),
    }));
    for (const { edit, before } of documents) await this.edited(caller, edit, before, tx);
    const evidence = await mapAsync(unique(input.evidenceIds), async (id) => {
      const a = await this.artifacts.get(caller, id, tx);
      return { id: a.id, hash: a.hash };
    });
    const proposal: PaperProposal = {
      id: newId('paperproposal'),
      projectId: caller.projectId,
      source: input.source,
      artifact: { id: artifact.id, hash: artifact.hash },
      documents,
      evidence,
      createdBy: caller.actorId,
      createdAt: now(),
      acceptance: null,
    };
    await tx.run(
      'INSERT INTO paper_proposals(id,project_id,record) VALUES(?,?,?)',
      proposal.id,
      caller.projectId,
      JSON.stringify(proposal),
    );
    await recorded(this.state, tx, caller, 'paper.proposed', proposal.id, {
      source: { ...proposal.source },
      artifactId: artifact.id,
    });
    return proposal;
  }
  async accept(caller: Caller, input: PaperAccept, tx: Transaction): Promise<PaperPublication[]> {
    this.open();
    this.state.assertTransaction(tx);
    await this.scope.require(caller, 'review', tx);
    const row = await tx.get<{ record: string; acceptance: string | null }>(
      'SELECT record,acceptance FROM paper_proposals WHERE id=? AND project_id=?',
      input.proposalId,
      caller.projectId,
    );
    check(row, 'paper_proposal_not_found', 'Paper proposal not found in this project', 404);
    const proposal = JSON.parse(row.record) as PaperProposal;
    check(
      digest(proposal.source) === digest(input.source),
      'paper_source_mismatch',
      'Approval must name the exact scientific submission',
      409,
    );
    check(
      proposal.createdBy !== caller.actorId,
      'review_independence',
      'Paper changes require the independent scientific reviewer',
      403,
    );
    if (row.acceptance) {
      const accepted = JSON.parse(row.acceptance) as NonNullable<PaperProposal['acceptance']>;
      check(
        accepted.reviewId === input.reviewId,
        'paper_already_accepted',
        'Proposal was accepted by another review',
        409,
      );
      return accepted.publications;
    }
    for (const pin of [proposal.artifact, ...proposal.evidence])
      check(
        (await this.artifacts.get(caller, pin.id, tx)).hash === pin.hash,
        'paper_evidence_changed',
        'Retained source evidence changed',
        409,
      );
    const publications = await mapAsync(proposal.documents, async ({ edit }) => {
      const before = await this.current(caller, edit.kind, tx);
      const after = {
        ...(await this.edited(caller, await this.rebased(caller, edit, before, tx), before, tx)),
        proposalId: proposal.id,
        updatedBy: proposal.createdBy,
      };
      await this.revision(caller, before, after, tx);
      const publication: PaperPublication = {
        id: newId('paperpub'),
        projectId: caller.projectId,
        kind: edit.kind,
        revision: after.revision,
        proposalId: proposal.id,
        source: proposal.source,
        reviewId: input.reviewId,
        evidence: proposal.evidence,
        createdBy: proposal.createdBy,
        createdAt: now(),
      };
      await tx.run(
        'INSERT INTO paper_publications(id,project_id,kind,revision,update_id,record) VALUES(?,?,?,?,?,?)',
        publication.id,
        caller.projectId,
        edit.kind,
        after.revision,
        `${proposal.id}:${edit.kind}`,
        JSON.stringify(publication),
      );
      return publication;
    });
    const acceptance = { reviewId: input.reviewId, reviewerId: caller.actorId, publications };
    await tx.run(
      'UPDATE paper_proposals SET acceptance=? WHERE id=?',
      JSON.stringify(acceptance),
      proposal.id,
    );
    await recorded(this.state, tx, caller, 'paper.accepted', proposal.id, {
      reviewId: input.reviewId,
    });
    return publications;
  }
}
export const paperPlugin = {
  name: 'merv-paper',
  inject: ['state', 'scope', 'artifacts'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(new PaperService(ctx.state, ctx.scope, ctx.artifacts));
      yield () => service.close();
      yield ctx.provide('paper', service);
    });
  },
};
export default paperPlugin;
