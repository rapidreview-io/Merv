import { createContext, useContext } from 'react';

const EntityRefContext = createContext(null);

/**
 * A surface-local override for every entity chip rendered inside it.
 *
 * Chips normally resolve an id against the home snapshot and navigate to the
 * entity's page. A surface that already holds the entity — the lit review
 * holds every paper and section it cites — can answer both questions better:
 *
 *   resolve(id)            → a resolved entity (EntityChip `seed` shape), so
 *                            the chip renders its real name with no fetch;
 *                            null falls back to the normal resolution.
 *   activate(id, resolved) → { onClick, label, hint } to handle the click in
 *                            place (scroll to it here) instead of navigating
 *                            to the page the reader is already on; null falls
 *                            back to the link.
 *
 * `value` must be referentially stable (useMemo) — it re-renders every chip
 * beneath it when its identity changes.
 */
export function EntityRefScope({ value, children }) {
  return <EntityRefContext.Provider value={value}>{children}</EntityRefContext.Provider>;
}

export function useEntityRefScope() {
  return useContext(EntityRefContext);
}
