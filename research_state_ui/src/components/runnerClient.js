/**
 * Loopback client for the merv-agent-runner settings service, shared by the
 * Auto running panel and its setup wizard. The service replies with
 * machine-readable error codes; translate the known ones.
 */

const RUNNER_ERRORS = {
  pairing_token_required: 'The runner rejected this pairing token.',
  origin_not_allowed: 'The runner does not allow this site; set MERV_AGENT_UI_ORIGINS on that machine.',
  forbidden: 'The runner refused the request.',
  runner_cannot_start: 'This runner is already active for another project.',
  runner_starting: 'The runner is already starting.',
};

const BRIDGE_SOURCE = 'merv-runner-bridge-v1';
const UI_SOURCE = 'merv-runner-ui-v1';
const BRIDGE_TIMEOUT_MS = 10_000;
let activeBridge = null;
let bridgeListenerInstalled = false;
const directBases = new Set();

export function runnerBase(url) {
  const base = url.trim().replace(/\/+$/, '');
  const target = new URL(base);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || !['http:', 'https:'].includes(target.protocol)
    || target.username
    || target.password
  ) {
    throw new Error('Runner URL must be an explicit loopback HTTP address.');
  }
  return base;
}

function requestError(payload, status) {
  const detail = payload?.error || payload?.detail || payload?.message;
  return new Error(
    RUNNER_ERRORS[detail] || detail || `Runner returned HTTP ${status}`,
  );
}

function onBridgeMessage(event) {
  const bridge = activeBridge;
  if (
    !bridge
    || event.source !== bridge.window
    || event.origin !== bridge.origin
    || event.data?.source !== BRIDGE_SOURCE
  ) return;
  if (event.data.type === 'ready') {
    bridge.ready = true;
    clearTimeout(bridge.readyTimer);
    bridge.resolveReady();
    return;
  }
  if (event.data.type !== 'response') return;
  const pending = bridge.pending.get(event.data.id);
  if (!pending) return;
  bridge.pending.delete(event.data.id);
  clearTimeout(pending.timer);
  if (event.data.ok) pending.resolve(event.data.payload);
  else pending.reject(requestError(event.data.payload, event.data.status));
}

function installBridgeListener() {
  if (bridgeListenerInstalled) return;
  window.addEventListener('message', onBridgeMessage);
  bridgeListenerInstalled = true;
}

export function connectRunnerBridge(url) {
  const base = runnerBase(url);
  if (
    activeBridge?.base === base
    && activeBridge.ready
    && !activeBridge.window.closed
  ) return Promise.resolve('bridge');
  if (
    activeBridge?.base === base
    && !activeBridge.ready
    && !activeBridge.window.closed
  ) return activeBridge.readyPromise;

  installBridgeListener();
  if (activeBridge?.window && !activeBridge.window.closed) activeBridge.window.close();
  const origin = new URL(base).origin;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const name = `merv_runner_${new URL(base).port || '80'}`;
  const popup = window.open(
    `${base}/bridge?origin=${encodeURIComponent(window.location.origin)}`,
    name,
    'popup,width=440,height=240',
  );
  if (!popup) {
    throw new Error('Allow the Merv runner pop-up, then try again.');
  }
  activeBridge = {
    base,
    origin,
    window: popup,
    pending: new Map(),
    ready: false,
    readyPromise,
    resolveReady: () => resolveReady('bridge'),
    rejectReady,
    readyTimer: null,
  };
  activeBridge.readyTimer = setTimeout(() => {
    if (activeBridge?.window === popup && !activeBridge.ready) {
      activeBridge = null;
      popup.close();
      rejectReady(new Error('The local runner connection did not open. Check that the service is running.'));
    }
  }, BRIDGE_TIMEOUT_MS);
  popup.focus();
  return readyPromise;
}

export function ensureRunnerTransport(url) {
  const base = runnerBase(url);
  if (directBases.has(base)) return Promise.resolve('direct');
  return connectRunnerBridge(base);
}

function bridgeRequest({ base, token, method, path, body }) {
  const bridge = activeBridge;
  if (
    !bridge
    || bridge.base !== base
    || !bridge.ready
    || bridge.window.closed
  ) throw new Error('The local runner connection is not open. Reconnect it and try again.');
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      reject(new Error('The local runner did not answer in time.'));
    }, BRIDGE_TIMEOUT_MS);
    bridge.pending.set(id, { resolve, reject, timer });
    bridge.window.postMessage({
      source: UI_SOURCE,
      type: 'request',
      id,
      token: (token || '').trim(),
      method,
      path,
      ...(body !== undefined ? { body } : {}),
    }, bridge.origin);
  });
}

export async function runnerRequest({ url, token, method = 'GET', path = '/settings', body }) {
  const base = runnerBase(url);
  if (
    activeBridge?.base === base
    && activeBridge.ready
    && !activeBridge.window.closed
  ) {
    return bridgeRequest({ base, token, method, path, body });
  }
  const response = await fetch(`${base}${path}`, {
    method,
    credentials: 'omit',
    targetAddressSpace: 'loopback',
    headers: {
      Authorization: `Bearer ${(token || '').trim()}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw requestError(payload, response.status);
  }
  directBases.add(base);
  return payload;
}

export function connectFailureMessage(error) {
  return error instanceof TypeError
    ? 'No settings service answered there. Start merv-agent-runner on that machine first.'
    : (error?.message || 'Could not connect to the local runner.');
}
