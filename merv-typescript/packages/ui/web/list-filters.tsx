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
