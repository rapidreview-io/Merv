import { z } from 'zod';
import { check, digest, type Caller } from '@merv/contracts';
import { createInput, id, type PiModelConfig } from './schema.js';

/** Server-owned role, never accepted from pi.create or a worker. Bump version whenever the
 * role's behavior changes. Context is untrusted request material, separate from instructions. */
export interface PiProfile {
  id: string;
  version: number;
  model: Pick<PiModelConfig, 'id' | 'effort'>;
  instructions: string;
  tools: readonly string[];
  context?(input: { binding: PiProfileBinding; caller: Caller }): Promise<string>;
  /** Additional request-scope check, run for every allowed call before the tool is invoked. */
  authorizeTool?(input: {
    binding: PiProfileBinding;
    caller: Caller;
    name: string;
    input: Record<string, unknown>;
  }): Promise<void>;
}

export interface PiProfileBinding {
  id: string;
  version: number;
  requestId: string;
}

export interface PiStoredProfile extends PiProfileBinding {
  definitionHash: string;
}

export const profiledCreateInput = createInput
  .extend({
    profile: z.object({ id, version: z.number().int().positive(), requestId: id }).strict(),
  })
  .strict();
export type PiProfiledCreate = z.input<typeof profiledCreateInput>;

const profileDefinition = z
  .object({
    id,
    version: z.number().int().positive(),
    model: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
        effort: z.enum(['none', 'low', 'medium']),
      })
      .strict(),
    instructions: z.string().trim().min(1).max(32_000),
    tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_.]*$/)).max(64),
  })
  .strict();

/** In-memory registrations deliberately fail closed when their owning plugin unloads. A
 * stored conversation also refuses a different definition registered under its old version. */
export class PiProfiles {
  private readonly entries = new Map<string, { profile: PiProfile; definitionHash: string }>();
  private key(binding: Pick<PiProfileBinding, 'id' | 'version'>) {
    return `${binding.id}@${binding.version}`;
  }
  register(input: PiProfile): () => void {
    const { context, authorizeTool, ...raw } = input;
    const result = profileDefinition.safeParse(raw);
    check(result.success, 'pi_profile_invalid', 'Invalid trusted conversation profile', 503);
    const definition = result.data;
    check(
      definition.tools.every((name) => !name.startsWith('pi.') && name !== 'machine.switch'),
      'pi_profile_invalid',
      'Conversation profiles cannot grant Pi or machine controls',
      503,
    );
    const key = this.key(definition);
    check(
      !this.entries.has(key),
      'pi_profile_duplicate',
      'Conversation profile already registered',
      503,
    );
    const entry = {
      profile: Object.freeze({
        ...definition,
        model: Object.freeze(definition.model),
        tools: Object.freeze([...new Set(definition.tools)].sort()),
        context,
        authorizeTool,
      }),
      definitionHash: digest({ ...definition, tools: [...new Set(definition.tools)].sort() }),
    };
    this.entries.set(key, entry);
    return () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
  }
  bind(binding: PiProfileBinding): PiStoredProfile {
    const entry = this.entries.get(this.key(binding));
    check(entry, 'pi_profile_unavailable', 'This conversation role is unavailable', 503);
    return { ...binding, definitionHash: entry.definitionHash };
  }
  get(binding: PiStoredProfile): PiProfile {
    const entry = this.entries.get(this.key(binding));
    check(
      entry && entry.definitionHash === binding.definitionHash,
      'pi_profile_unavailable',
      'This conversation role is unavailable or has changed; its original version is required',
      503,
    );
    return entry.profile;
  }
}
