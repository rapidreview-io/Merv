import { z } from 'zod';
import { check, digest, type Caller } from '@merv/contracts';
import { createInput, id, type PiModelConfig } from './schema.js';

import type { PiProfile, PiProfileBinding, PiStoredProfile } from './profile-types.js';
export type * from './profile-types.js';
export const profiledCreateInput = createInput
  .extend({
    profile: z.object({ id, version: z.number().int().positive(), requestId: id }).strict(),
  })
  .strict();

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
    // Absent for a role without one, so earlier definitions keep their hash.
    shell: z.literal(true).optional(),
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
