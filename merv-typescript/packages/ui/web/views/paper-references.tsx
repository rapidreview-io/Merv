import { useState, type FormEvent } from 'react';
import { useTool } from '../api';
import { Area, Failure, LoadState, StatusPill, words } from '../components';
import { RecordText } from '../markdown';

/**
 * What `project.references` answers about one reference: what it names, and
 * whether this project holds it.
 */
interface Reference {
  ref: string;
  status: 'resolved' | 'missing' | 'unsupported';
  label?: string;
  state?: string;
}

/**
 * The one thing the retired Knowledge page did that nothing else does: read the
 * metadata behind references an agent quoted. It is a lookup, not a collection,
 * so it is a quiet control beside the paper rather than a place of its own. What
 * it reads is what an agent wrote, pasted as it was written — nobody picks these by
 * name, because whether the name exists is the question — so the field says that
 * in the one place a field may: its own placeholder.
 */
export function ReferenceLookup() {
  const [text, setText] = useState('');
  const [refs, setRefs] = useState<string[] | null>(null);
  const [error, setError] = useState<string>();
  const lookup = useTool<Reference[]>(refs ? 'project.references' : null, { refs: refs ?? [] });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = text.split(/\s+/).filter(Boolean);
    if (!next.length || next.length > 200) {
      setError('Paste between 1 and 200 references.');
      return;
    }
    setError(undefined);
    setRefs(next);
    lookup.reload();
  };
  return (
    <section className="stack">
      <form
        className="card stack entry-form"
        aria-label="Look up cited references"
        onSubmit={submit}
      >
        <Area
          label="References"
          className="mono"
          rows={3}
          maxLength={40200}
          placeholder="Paste what an agent cited, one reference to a line"
          value={text}
          onChange={setText}
        />
        <Failure message={error} />
        <div>
          <button className="btn" disabled={lookup.loading || !text.trim()}>
            Check
          </button>
        </div>
      </form>
      <LoadState {...lookup} />
      {lookup.data && !lookup.error && (
        <ul className="rows">
          {lookup.data.map((item, index) => (
            <li className="row" key={`${index}:${item.ref}`}>
              <span className="row-name">
                {/* A reference nobody could name is shortened, never printed as its id. */}
                <strong>{item.label ?? <RecordText text={item.ref} />}</strong>
                <StatusPill value={item.status} />
              </span>
              <span className="states-detail">{item.state ? words(item.state) : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
