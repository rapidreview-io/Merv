import { check, MervError, type Caller, type Scope } from '@merv/contracts';
import type { CredentialBinding } from './types.js';

export type { CredentialBinding } from './types.js';

const key = (projectId: string, actorId: string, mountId: string) =>
  JSON.stringify([projectId, actorId, mountId]);

/** Exact (project, actor, mount) bindings, fixed for one load of the Mounts entry. */
export class Bindings {
  readonly #scope: Pick<Scope, 'authorityActor' | 'recognizesCredential'>;
  readonly #byCaller: Map<string, CredentialBinding>;
  constructor(
    scope: Pick<Scope, 'authorityActor' | 'recognizesCredential'>,
    bindings: readonly CredentialBinding[],
  ) {
    this.#scope = scope; // private: inspecting or serializing Bindings never reaches Scope
    this.#byCaller = new Map(bindings.map((b) => [key(b.projectId, b.actorId, b.mountId), b]));
  }

  /** Callers arrive authorized (discovery checks its actor); a session uses its owner's binding. */
  async select(caller: Caller, mountId: string): Promise<CredentialBinding> {
    const owner = caller.session ? await this.#scope.authorityActor(caller) : undefined;
    const binding = this.#byCaller.get(
      key(owner?.projectId ?? caller.projectId, owner?.id ?? caller.actorId, mountId),
    );
    const text = 'No credential binding grants this upstream identity';
    check(binding, 'credential_forbidden', text, 403);
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
    // A Merv credential stays local, even expired, rotated or revoked; others need operator setup.
    let local: boolean;
    try {
      local = await this.#scope.recognizesCredential(secret);
    } catch {
      throw new MervError('credential_unavailable', 'Upstream credential validation failed', 503);
    }
    const text = 'A Merv bearer credential cannot be used for an upstream service';
    check(!local, 'credential_unavailable', text, 503);
    return { ...binding.headers, authorization: `Bearer ${secret}` };
  }
}
