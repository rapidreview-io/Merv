import {
  check,
  idPattern as identifier,
  MervError,
  type Caller,
  type Scope,
} from '@merv/contracts';
import type { CredentialBinding } from './types.js';

export type { CredentialBinding } from './types.js';

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

const key = (projectId: string, actorId: string, mountId: string) =>
  JSON.stringify([projectId, actorId, mountId]);

/** Exact (project, actor, mount) bindings, fixed for one load of the Mounts entry. */
export class Bindings {
  readonly #scope: Pick<Scope, 'authorityActor' | 'recognizesCredential'>;
  readonly #byCaller = new Map<string, CredentialBinding>();
  constructor(
    scope: Pick<Scope, 'authorityActor' | 'recognizesCredential'>,
    bindings: CredentialBinding[] = [],
  ) {
    this.#scope = scope;
    check(
      Array.isArray(bindings),
      'invalid_credential_config',
      'Credential bindings must be an array',
    );
    const ids = new Set<string>();
    for (const input of bindings) {
      const binding = validateBinding(input),
        selection = key(binding.projectId, binding.actorId, binding.mountId);
      check(
        !ids.has(binding.id) && !this.#byCaller.has(selection),
        'invalid_credential_config',
        'Credential binding IDs and actor/project/mount selections must be unique',
      );
      ids.add(binding.id);
      this.#byCaller.set(selection, binding);
    }
  }

  /**
   * The registry authorized the caller, and a discovery round checks its own actor. An agent
   * session acts through its authority actor's binding.
   */
  async select(caller: Caller, mountId: string): Promise<CredentialBinding> {
    const owner = caller.session ? await this.#scope.authorityActor(caller) : undefined;
    const binding = this.#byCaller.get(
      key(owner?.projectId ?? caller.projectId, owner?.id ?? caller.actorId, mountId),
    );
    check(
      binding,
      'credential_forbidden',
      'No credential binding grants this upstream identity',
      403,
    );
    return binding;
  }

  /** Read once per connection and handed only to that connection's transport. */
  async headers(binding: CredentialBinding): Promise<Record<string, string>> {
    const secret = process.env[binding.secretRef.slice(4)];
    check(
      typeof secret === 'string' && secret.length <= 8192 && /^[A-Za-z0-9\-._~+/]+=*$/.test(secret),
      'credential_unavailable',
      'The configured upstream bearer credential is unavailable or invalid',
      503,
    );
    // A local credential stays local after expiry, rotation or revocation.
    // Unknown tokens still require explicit upstream operator configuration.
    let local: boolean;
    try {
      local = await this.#scope.recognizesCredential(secret);
    } catch {
      throw new MervError('credential_unavailable', 'Upstream credential validation failed', 503);
    }
    check(
      !local,
      'credential_unavailable',
      'A Merv bearer credential cannot be used for an upstream service',
      503,
    );
    return { ...binding.headers, authorization: `Bearer ${secret}` };
  }
}
