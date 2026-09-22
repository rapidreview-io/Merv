import { inspect } from 'node:util';
import { check, digest, MervError, type Caller, type Scope } from '@merv/contracts';
import type { CredentialBinding, CredentialProvider, ResolvedCredential } from './types.js';

export type { CredentialBinding, CredentialProvider, ResolvedCredential } from './types.js';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const mountIdentifier = /^[a-z0-9][a-z0-9-]{0,63}$/;
const secretReference = /^env:[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const selectorName = /^x-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reservedSelector =
  /(?:^|-)(?:auth|authorization|bearer|key|keys|apikey|token|tokens|secret|secrets|credential|credentials|password|passwd|passphrase|pwd|signature|jwt|assertion|cookie|host|protocol|session|mcp|forwarded|proxy|connection|content|accept|origin|referer|transfer|upgrade)(?:-|$)/;
const bindingFields = new Set(['id', 'projectId', 'actorId', 'mountId', 'secretRef', 'headers']);
const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bindingKey = (caller: Caller, mountId: string) =>
  JSON.stringify([caller.projectId, caller.actorId, mountId]);

function validateBinding(input: CredentialBinding): CredentialBinding {
  check(
    plainObject(input) && Object.keys(input).every((field) => bindingFields.has(field)),
    'invalid_credential_config',
    'Credential bindings must contain only the supported fields',
  );
  for (const field of ['id', 'projectId', 'actorId'] as const)
    check(
      typeof input[field] === 'string' && identifier.test(input[field]),
      'invalid_credential_config',
      'Credential bindings require exact nonempty identifiers',
    );
  check(
    typeof input.mountId === 'string' && mountIdentifier.test(input.mountId),
    'invalid_credential_config',
    'Credential bindings require a valid mount ID',
  );
  check(
    typeof input.secretRef === 'string' && secretReference.test(input.secretRef),
    'invalid_credential_config',
    'Credential secrets must use an env:NAME reference',
  );
  const headers: Record<string, string> = {};
  if (input.headers !== undefined) {
    check(
      plainObject(input.headers) && Object.keys(input.headers).length <= 16,
      'invalid_credential_config',
      'Credential headers must be a record of at most 16 fixed selectors',
    );
    for (const [name, value] of Object.entries(input.headers)) {
      const normalized = name.toLowerCase();
      check(
        name.length <= 100 &&
          selectorName.test(normalized) &&
          !reservedSelector.test(normalized) &&
          !Object.hasOwn(headers, normalized),
        'invalid_credential_config',
        'Only distinct nonsecret x-* selector headers are allowed',
      );
      check(
        typeof value === 'string' &&
          value.length >= 1 &&
          value.length <= 1024 &&
          value.trim() === value &&
          /^[\x20-\x7e]+$/.test(value) &&
          !/^(?:Bearer\s|Basic\s|env:|-----BEGIN)/i.test(value),
        'invalid_credential_config',
        'Selector headers require fixed printable nonsecret values',
      );
      headers[normalized] = value;
    }
  }
  return {
    id: input.id,
    projectId: input.projectId,
    actorId: input.actorId,
    mountId: input.mountId,
    secretRef: input.secretRef,
    headers,
  };
}

class CredentialSnapshot implements ResolvedCredential {
  #headers: Readonly<Record<string, string>>;
  constructor(
    readonly identityKey: string,
    headers: Record<string, string>,
  ) {
    this.#headers = Object.freeze({ ...headers });
    Object.freeze(this);
  }
  headers(): Readonly<Record<string, string>> {
    return this.#headers;
  }
  toJSON(): { identityKey: string } {
    return { identityKey: this.identityKey };
  }
  [inspect.custom](): { identityKey: string } {
    return this.toJSON();
  }
}

/**
 * Exact actor/project bindings, fixed at construction; reload the Mounts entry to change them.
 * Secrets are read only when a new invocation resolves authority.
 */
export class EnvironmentCredentials implements CredentialProvider {
  readonly #scope: Scope;
  readonly #bindings = new Map<string, CredentialBinding>();
  constructor(scope: Scope, bindings: CredentialBinding[] = []) {
    this.#scope = scope;
    check(
      Array.isArray(bindings),
      'invalid_credential_config',
      'Credential bindings must be an array',
    );
    const ids = new Set<string>();
    for (const input of bindings) {
      const binding = validateBinding(input),
        key = bindingKey(binding, binding.mountId);
      check(
        !ids.has(binding.id) && !this.#bindings.has(key),
        'invalid_credential_config',
        'Credential binding IDs and actor/project/mount selections must be unique',
      );
      ids.add(binding.id);
      this.#bindings.set(key, binding);
    }
  }

  async resolve(caller: Caller, mountId: string): Promise<ResolvedCredential> {
    await this.#scope.require(caller, 'read');
    check(
      typeof mountId === 'string' && mountIdentifier.test(mountId),
      'invalid_mount',
      'A valid mount ID is required',
    );
    const authority = caller.session ? await this.#scope.authorityActor(caller) : undefined;
    const selection = bindingKey(
      authority ? { actorId: authority.id, projectId: authority.projectId } : caller,
      mountId,
    );
    const binding = this.#bindings.get(selection);
    check(
      binding,
      'credential_forbidden',
      'No credential binding grants this upstream identity',
      403,
    );
    const secret = process.env[binding.secretRef.slice(4)];
    check(
      typeof secret === 'string' &&
        secret.length >= 1 &&
        secret.length <= 8192 &&
        /^[A-Za-z0-9\-._~+/]+=*$/.test(secret),
      'credential_unavailable',
      'The configured upstream bearer credential is unavailable or invalid',
      503,
    );
    // A local credential stays local after expiry, rotation or revocation.
    // Unknown tokens still require explicit upstream operator configuration.
    let local: boolean;
    try {
      // Session credentials remain reserved even when their provider is unloaded.
      local =
        (secret.startsWith('ms_') && !/^[A-Za-z0-9_-]{43}$/.test(secret)) ||
        (await this.#scope.recognizesCredential(secret));
    } catch {
      throw new MervError('credential_unavailable', 'Upstream credential validation failed', 503);
    }
    check(
      !local,
      'credential_unavailable',
      'A Merv bearer credential cannot be used for an upstream service',
      503,
    );
    return new CredentialSnapshot(`credential_${digest({ ...binding, secret })}`, {
      ...binding.headers,
      authorization: `Bearer ${secret}`,
    });
  }
}
