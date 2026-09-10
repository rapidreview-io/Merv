import { createStore } from '../store/createStore';

/**
 * Tiny toast bus — a module singleton, the same pattern as useViewport /
 * useTheme. `toast(msg)` from anywhere; <ToastHost/> (mounted in MobileShell)
 * renders the stack.
 */
const store = createStore([]);
let seq = 0;

export function toast(message, { variant = 'info', duration = 2600 } = {}) {
  const id = ++seq;
  store.set([...store.get(), { id, message, variant }]);
  setTimeout(() => store.set(store.get().filter(t => t.id !== id)), duration);
  return id;
}

export function useToasts() {
  return store.use();
}
