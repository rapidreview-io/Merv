/** Portable work-unit publication status without runtime schema dependencies. */
/**
 * Where a unit that publishes its accepted code to main stands. Null for every unit that
 * does not publish, and for one that is marked but not accepted yet: publication begins at
 * acceptance. `pending` is a wait on a signed-in operator, never a failure of the work, and
 * `unsealed` is the accepted unit whose facts could not open a publication at all.
 */
export interface CodeUnitPublication {
  /** Omitted on historical GitHub publications. */
  destination?: 'local' | 'github';
  state:
    | 'pending'
    | 'stale'
    | 'setup_required'
    | 'disabled'
    | 'closed'
    | 'unsealed'
    | 'incident'
    | 'published';
  pull?: { number: number; url: string };
  /** The verified merge commit on main; present only once `published`. */
  mergeCommit?: string;
}
