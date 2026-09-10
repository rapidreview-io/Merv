import { useSyncExternalStore } from 'react';

/**
 * The module-singleton external store this app keeps its outside-React state
 * in: one value, a set of listeners, and a hook that subscribes a component.
 * Seven of these were each declaring their own `listeners` Set and their own
 * subscribe closure.
 *
 * `set` always notifies, even for an equal value: some stores (the theme) hang
 * a derived snapshot off the same listeners, and `useSyncExternalStore`
 * already refuses to re-render on an unchanged snapshot.
 */
export function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const emit = () => { for (const fn of listeners) fn(); };
  return {
    subscribe,
    emit,
    get: () => value,
    set(next) { value = next; emit(); },
    /** Subscribe a component; `select` derives from the stored value. */
    use(select) {
      const snapshot = select ? () => select(value) : () => value;
      return useSyncExternalStore(subscribe, snapshot, snapshot);
    },
  };
}
