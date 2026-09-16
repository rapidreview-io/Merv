import { createService } from '@merv/contracts';
import type { Artifacts, Scope, State } from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type { Code } from './types.js';
import { CodeCommandService } from './commands.js';
import { CodeProposalService } from './proposals.js';
import { CodeCaptureReader } from './captures.js';

/** One Code capability; immutable proposals and machine commands retain separate records. */
export class CodeService extends CodeCommandService implements Code {
  private proposalStore!: CodeProposalService;
  private captureReader!: CodeCaptureReader;
  constructor(state: State, scope: Scope, sessions: Sessions, artifacts: Artifacts) {
    super(state, scope, sessions);
    const initializeBase = this.initialize.bind(this);
    this.initialize = async () => {
      await initializeBase();

      this.captureReader = new CodeCaptureReader(state, scope, sessions);
      try {
        this.proposalStore = await createService(
          new CodeProposalService(this, state, scope, sessions, artifacts),
        );
      } catch (error) {
        super.close();
        throw error;
      }
    };
  }
  async capture(...args: Parameters<CodeCaptureReader['capture']>) {
    return await this.captureReader.capture(...args);
  }
  async seal(...args: Parameters<CodeProposalService['seal']>) {
    return await this.proposalStore.seal(...args);
  }
  async proposal(...args: Parameters<CodeProposalService['proposal']>) {
    return await this.proposalStore.proposal(...args);
  }
  async proposals(...args: Parameters<CodeProposalService['proposals']>) {
    return await this.proposalStore.proposals(...args);
  }
  override close(): void {
    this.captureReader.close();
    this.proposalStore.close();
    super.close();
  }
}
