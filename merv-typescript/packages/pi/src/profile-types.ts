import type { Caller } from '@merv/contracts';
import type { PiModelConfig } from './models.js';
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

export interface PiProfiledCreate {
  requestId: string;
  title?: string;
  profile: PiProfileBinding;
}
