import type { ReactNode } from 'react';
import type { Loaded } from './api';
import { LoadState } from './components';

interface ListFiltersProps {
  noun: string;
  placeholder: string;
  query: string;
  onQueryChange(value: string): void;
  state: string;
  onStateChange(value: string): void;
  states: readonly string[];
  stateLabel?: 'State' | 'Status';
  shown: number;
  total: number;
}

/** One quiet row: the placeholder carries the hint, and the count only while a filter bites. */
export function ListFilters({
  noun,
  placeholder,
  query,
  onQueryChange,
  state,
  onStateChange,
  states,
  stateLabel = 'State',
  shown,
  total,
}: ListFiltersProps) {
  const filtering = !!(query || state);
  return (
    <div className="action-row">
      <input
        className="input"
        type="search"
        aria-label={`Search ${noun}`}
        placeholder={placeholder}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <select
        className="input"
        aria-label={`${stateLabel} filter`}
        value={state}
        onChange={(event) => onStateChange(event.target.value)}
      >
        <option value="">{stateLabel === 'Status' ? 'All statuses' : 'All states'}</option>
        {states.map((value) => (
          <option key={value} value={value}>
            {value.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
      {filtering && (
        <span className="muted" role="status">
          {shown} of {total} {noun}
        </span>
      )}
      {filtering && (
        <button
          type="button"
          className="btn-text"
          onClick={() => {
            onQueryChange('');
            onStateChange('');
          }}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

/**
 * Every filtered list renders the same skeleton in the same order and differs only in
 * which parts are true: the filter row while there is something to filter, the state of
 * the read, the distinct screen for filtered-to-nothing, and the table itself. A failed
 * read is the one state that replaces the list rather than sitting beside it.
 */
export function ListPage<T>({
  list,
  visible,
  emptyTitle,
  emptyHint,
  children,
  ...filters
}: Omit<ListFiltersProps, 'shown' | 'total'> & {
  list: Loaded<T[]>;
  visible: number;
  emptyTitle: string;
  emptyHint: string;
  children: ReactNode;
}) {
  const listed = !!list.data?.length && !list.error;
  return (
    <div className="page-stage stack">
      {listed && <ListFilters {...filters} shown={visible} total={list.data!.length} />}
      <LoadState
        loading={list.loading}
        error={list.error}
        empty={list.data?.length === 0}
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
      />
      {listed && !list.loading && visible === 0 && (
        <LoadState
          loading={false}
          empty
          emptyTitle={`No ${filters.noun} match these filters`}
          emptyHint="Try another search or clear the filters."
        />
      )}
      {visible > 0 && !list.error && children}
    </div>
  );
}
