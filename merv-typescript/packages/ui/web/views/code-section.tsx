import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CodeUnit } from '@merv/contracts/code-units';
import { Ago, CopyButton, KV, Short, StatusPill, cx, words } from '../components';
import { ArrowRightIcon } from '../icons';
import { RecordLink, useRecordNames, type RecordNames } from '../markdown';

/**
 * What Git holds for one record, on the record's own page: the branch a writer stands
 * on, what it was cut from, where its work has got to, and the commit its review
 * accepted. It is a section of the record and not a second record page, and it reads
 * the `codeUnit` the row already serves with every record, so it costs no read.
 *
 * A line with no fact behind it is not drawn. No blocker is printed: each is an
 * instruction to the agent holding the tool, and the state words here already say
 * what a person can see.
 */

/** Where the same facts are drawn as one picture. */
const CANVAS = '/code';

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
}: {
  unit: CodeUnit;
  /** Who accepted it, by name; nobody is named by an identifier. */
  named(id: string | null | undefined): string | undefined;
}) {
  const accepted = unit.acceptance;
  const names = useRecordNames(
    [...(unit.base?.sources ?? []).map((source) => source.unitId), accepted?.reviewRef]
      .filter(Boolean)
      .join(' '),
  );
  const base = basedOn(unit, names);
  const lagging = !!unit.canonicalHead && unit.canonicalHead !== unit.mirroredHead;
  return (
    <div className={cx('stack', unit.quarantine && 'code-refused')}>
      <KV
        rows={[
          [
            'Branch',
            <>
              <code className="mono">{unit.branch}</code>
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
        ]}
      />
      {unit.quarantine && (
        <p className="code-refusal">The pin and the acceptance retained here cannot be reused.</p>
      )}
      <Link className="btn-text" to={CANVAS}>
        Open in the canvas <ArrowRightIcon size={14} />
      </Link>
    </div>
  );
}
