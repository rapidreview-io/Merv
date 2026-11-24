import type { DeskCall } from './desk-calls';
import type { Provider, SessionOptions } from '@merv/protocol/runtime';

/** What a new session with an agent starts on until its folder has choices of its own: set in Settings. */
export type AgentDefaults = Pick<SessionOptions, 'model' | 'effort' | 'speed' | 'access'>;
const key = (provider: Provider) => `merv:defaults:${provider}`;

export function agentDefaults(provider: Provider): AgentDefaults {
  try {
    const value = JSON.parse(localStorage.getItem(key(provider)) ?? '{}');
    const text = (field: unknown) => (typeof field === 'string' && field ? field : undefined);
    return {
      model: text(value.model),
      effort: text(value.effort),
      speed: text(value.speed),
      access:
        value.access === 'full' || value.access === 'edit' || value.access === 'ask'
          ? value.access
          : undefined,
    };
  } catch {
    return {};
  }
}

/** Keeps what new sessions with this agent start on. A setting changed here also clears the same
 *  setting from every folder's remembered choices, so the next session anywhere starts on it. `call` is the Mac's desk. */
export function keepAgentDefaults(
  call: DeskCall,
  provider: Provider,
  next: AgentDefaults,
  before: AgentDefaults = agentDefaults(provider),
) {
  try {
    localStorage.setItem(key(provider), JSON.stringify(next));
    const changed = (['model', 'effort', 'speed', 'access'] as const).filter(
      (field) => next[field] !== before[field],
    );
    if (changed.length) forgetFolderChoices(provider, changed);
    // Told to the window when there still is one: a sync that fails after the page is gone has no one to tell.
    void syncCreationDefaults(call).catch((error) =>
      globalThis.window?.dispatchEvent(
        new CustomEvent('creation-defaults-error', { detail: String(error) }),
      ),
    );
  } catch {
    /* A window without storage keeps them until it closes. */
  }
}

function forgetFolderChoices(provider: Provider, fields: readonly string[]) {
  const prefix = `merv:session:${provider}:`;
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const name = localStorage.key(index);
    if (!name?.startsWith(prefix)) continue;
    try {
      const value = JSON.parse(localStorage.getItem(name) ?? '{}');
      for (const field of fields) delete value[field];
      localStorage.setItem(name, JSON.stringify(value));
    } catch {
      /* One unreadable folder keeps what it had. */
    }
  }
}

let writes: Promise<unknown> = Promise.resolve();
function snapshot() {
  const values: Record<
    string,
    { model?: string; effort?: string; speed?: string; access?: SessionOptions['access'] }
  > = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!/^merv:(defaults:(claude|codex)|session:(claude|codex):.+)$/.test(key)) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key)!);
      values[key] = {
        model: value.model,
        effort: value.effort,
        speed: value.speed,
        access: value.access,
      };
    } catch {}
  }
  return values;
}
let previous: ReturnType<typeof snapshot> = {};
let loaded = false,
  revision = 0;
/** Tells the Mac's desk what new sessions start on, so its own sessions start on the same. */
export function syncCreationDefaults(call: DeskCall) {
  const values = snapshot(),
    before = previous;
  previous = values;
  revision++;
  writes = writes.catch(() => {}).then(() => call('creation-defaults', { values, before }));
  return writes;
}
export async function loadCreationDefaults(call: DeskCall) {
  await writes.catch(() => {});
  const before = snapshot(),
    at = revision;
  const saved = await call<ReturnType<typeof snapshot>>(
    'creation-defaults',
    loaded ? undefined : { values: before, migrate: true },
  );
  // A choice made while the read was on its way wins over this older snapshot.
  if (at !== revision || JSON.stringify(before) !== JSON.stringify(snapshot())) return;
  for (const [key, fields] of Object.entries(saved)) {
    let value = {};
    try {
      value = JSON.parse(localStorage.getItem(key) ?? '{}');
    } catch {}
    localStorage.setItem(
      key,
      JSON.stringify({
        ...value,
        model: fields.model,
        effort: fields.effort,
        speed: fields.speed,
        access: fields.access,
      }),
    );
  }
  loaded = true;
  previous = snapshot();
  window.dispatchEvent(new window.Event('creation-defaults-changed'));
}
