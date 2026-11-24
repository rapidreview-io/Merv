/**
 * Opening an agent's session from the board or the chat. In merv-desktop this opened a thread on
 * the person's Mac; in Merv a session is one of the project's agent threads, which the Agents page
 * opens (`/sessions?thread=<id>`), and whoever shows sessions on this page may answer first.
 */
type SessionTarget = { device?: string; thread: string; done?: boolean };
const listeners = new Set<(target: SessionTarget) => void>();

export function onOpenSession(hear: (target: SessionTarget) => void) {
  listeners.add(hear);
  return () => void listeners.delete(hear);
}

export const sessionPath = (thread: string) => `/sessions?thread=${encodeURIComponent(thread)}`;

export function openSession(
  target: SessionTarget,
  go: (url: string) => void = (url) => location.assign(url),
) {
  if (listeners.size) for (const hear of listeners) hear(target);
  else go(`/ui${sessionPath(target.thread)}`);
}
