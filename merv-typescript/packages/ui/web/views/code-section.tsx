import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CodeUnit } from '@merv/contracts/code-units';
import { Ago, CopyButton, KV, Short, StatusPill, Summary, cx, words } from '../components';
import { ArrowRightIcon, ExternalIcon } from '../icons';
import { RecordLink, useRecordNames, type RecordNames } from '../markdown';
import { firstPersonMove, publicationBlocker } from './code-blockers';

/**
 * What Git holds for one record, on the record's own page: the branch a writer stands
 * on, what it was cut from, where its work has got to, and the commit its review
 * accepted. It is a section of the record and not a second record page, and it reads
 * the `codeUnit` the row already serves with every record, so it costs no read.
 *
 * A line with no fact behind it is not drawn. One blocker may be printed, and only
 * one whose next move is a person's: it leads the section as the sentence of
 * `code-blockers.ts`, with who ends the wait and the server's own instruction folded
 * behind it. Every other code stays unprinted, because the state words here and the
 * Act ladder already say what a person can see.
 */

/** Where the same facts are drawn as one picture. */
const CANVAS = '/code';

/**
 * A publication that stopped rather than one in flight. Only `pending` is still moving and
 * only `published` arrived; everything else — closed, unsealed, stale, disabled, incident —
 * is a publication that will not reach main as it stands, and reads in the refusal's colour.
 */
const refused = (state: string) => state !== 'pending' && state !== 'published';

/**
 * The branch is the string an operator fetches, so it is stated — but the id inside it
 * is read the way every digest here is read: its head and its tail, the whole of it in
 * the hover and on the clipboard. Nobody types thirty-two hex digits.
 */
const shortBranch = (branch: string) =>
  branch.replace(/[0-9a-f]{24,}/gi, (id) => `${id.slice(0, 8)}…${id.slice(-6)}`);

/** The records whose acceptances a base was made of, named rather than printed as oids. */
const sources = (of: { unitId: string }[], names: RecordNames) =>
  of.map((source) => <RecordLink key={source.unitId} id={source.unitId} names={names} />);

/**
 * What the unit stands on. A pin is a fact and names the records it was made of; where
 * there is none, the derivation says how near one is, and a merge still to be made is
 * how many accepted commits it will join — never the digest that would name it.
 */
function basedOn(unit: CodeUnit, names: RecordNames): ReactNode {
  const pin = unit.base;
  // Which branch the trunk is, is the repository's answer and not this page's, so the pin
  // is said by what it is rather than by a name invented here.
  if (pin?.kind === 'main')
    return (
      <>
        <span>the base branch</span>
        <Short value={pin.reference} />
      </>
    );
  if (pin?.kind === 'accepted') return sources(pin.sources, names);
  if (pin)
    return (
      <>
        <span>a merge of {pin.sources.length} accepted commits</span>
        {sources(pin.sources, names)}
      </>
    );
  const status = unit.baseStatus;
  if (!status) return null;
  const merge = 'merge' in status ? status.merge : undefined;
  return (
    <>
      <StatusPill value={status.status} />
      {status.status === 'ready' && <span>{words(status.kind)}</span>}
      {!!merge?.length && <span>a merge of {merge.length} accepted commits</span>}
    </>
  );
}

export function UnitCode({
  unit,
  named,
  open,
  signedIn,
}: {
  unit: CodeUnit;
  /** Who accepted it, by name; nobody is named by an identifier. */
  named(id: string | null | undefined): string | undefined;
  /**
   * The section's one link. On a record's page it is the way to the drawing; drawn
   * inside the drawing, the way out is the record instead.
   */
  open?: ReactNode;
  /**
   * Whether the reader is the signed-in operator the publication verbs answer. The move
   * is said to everybody, and offered only to whoever can make it: a control a reader
   * would follow to a page that draws no button for them promises an act (ruling 11).
   */
  signedIn?: boolean;
}) {
  const accepted = unit.acceptance;
  const names = useRecordNames(
    [...(unit.base?.sources ?? []).map((source) => source.unitId), accepted?.reviewRef]
      .filter(Boolean)
      .join(' '),
  );
  const base = basedOn(unit, names);
  const lagging = !!unit.canonicalHead && unit.canonicalHead !== unit.mirroredHead;
  const publication = unit.publication;
  // The blockers this read carries: what a base would refuse now, and the one Code keeps
  // about a publication, which is the only opinion it holds about work that has ended.
  const held = firstPersonMove(
    [
      ...(unit.baseStatus?.status === 'blocked' ? unit.baseStatus.blockers : []),
      ...[publicationBlocker(publication)].filter((item) => !!item),
    ],
    names,
  );
  return (
    <div className={cx('stack', unit.quarantine && 'code-refused')}>
      {/* The move leads, in the standing line's own grammar: the sentence, who ends the
          wait, the one control a page of this app makes — and the agent's instruction
          folded in the fold Now uses, so the two readings are one thing. */}
      {!!held && (
        <div className="stack stack--tight">
          <p className="ov-say">{held.move.sentence}</p>
          <span className="ov-meta">
            <span>{held.move.who}</span>
            {!!held.blocker.since && <Ago at={held.blocker.since} />}
          </span>
          {/* Every move of this vocabulary is made on the canvas, so drawn inside the
              canvas the control would lead to the page it already stands on. */}
          {!!held.move.control && signedIn && !open && (
            <Link className="btn-text" to={held.move.control.to}>
              {held.move.control.label} <ArrowRightIcon size={14} />
            </Link>
          )}
          {!!held.blocker.next && (
            <details className="ov-said">
              <Summary>Agent instructions</Summary>
              <p>{held.blocker.next}</p>
            </details>
          )}
        </div>
      )}
      <KV
        rows={[
          [
            'Branch',
            <>
              <code className="mono" title={unit.branch}>
                {shortBranch(unit.branch)}
              </code>
              <CopyButton text={unit.branch} label="Copy branch name" />
            </>,
          ],
          !!base && ['Based on', base],
          !!unit.canonicalHead && [
            'Working',
            <>
              <StatusPill value={unit.writerState} />
              <Short value={unit.canonicalHead} />
              {/* Mirror lag is an element on the canvas and one clause here, never a count.
                  The clause names the commit the mirror holds, which is the one it is about
                  and never the head beside it; a lane the mirror never reached says nothing. */}
              {lagging && unit.mirroredHead && unit.mirroredAt && (
                <span className="muted">
                  the mirror is at <Short value={unit.mirroredHead} /> <Ago at={unit.mirroredAt} />
                </span>
              )}
            </>,
          ],
          !!accepted && [
            'Accepted',
            accepted.storage === 'none' ? (
              <span>succeeded without code, so a later base looks past it</span>
            ) : (
              <>
                {accepted.reference && <Short value={accepted.reference} />}
                <Ago at={accepted.acceptedAt} />
                {named(accepted.acceptedBy) && <span>{named(accepted.acceptedBy)}</span>}
                {accepted.reviewAttached && <RecordLink id={accepted.reviewRef} names={names} />}
              </>
            ),
          ],
          // Where this unit's accepted code stands on its way to main. The state is a pill,
          // the pull request is the link GitHub keeps it at, and the merge commit is the
          // one fact that ends it; a publication stopped rather than in flight is read in
          // the refusal's colour, as everything stopped on this page is.
          !!publication && [
            'Publication',
            <span className={cx('cluster', refused(publication.state) && 'code-refusal')}>
              <StatusPill value={publication.state} />
              {!!publication.pull && (
                <a
                  className="btn-text"
                  href={publication.pull.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {`#${publication.pull.number}`} <ExternalIcon size={14} />
                </a>
              )}
              {!!publication.mergeCommit && <Short value={publication.mergeCommit} />}
            </span>,
          ],
        ]}
      />
      {unit.quarantine && (
        <p className="code-refusal">The pin and the acceptance retained here cannot be reused.</p>
      )}
      {open ?? (
        <Link className="btn-text" to={CANVAS}>
          Open in the canvas <ArrowRightIcon size={14} />
        </Link>
      )}
    </div>
  );
}
