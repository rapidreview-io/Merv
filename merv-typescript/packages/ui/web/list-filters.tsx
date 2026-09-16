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
  return (
    <div className="cluster">
      <label>
        Search{' '}
        <input
          className="input"
          type="search"
          aria-label={`Search ${noun}`}
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      <label>
        {stateLabel}{' '}
        <select
          className="input"
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
      </label>
      {(query || state) && (
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            onQueryChange('');
            onStateChange('');
          }}
        >
          Clear filters
        </button>
      )}
      <span className="muted" role="status">
        {shown} of {total} {noun}
      </span>
    </div>
  );
}
