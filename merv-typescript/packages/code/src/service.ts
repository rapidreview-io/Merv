import { createService } from '@merv/contracts';
import type { Artifacts, Scope, State } from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type { Code } from './types.js';
import { CodeCommandService } from './commands.js';
import { CodeProposalService } from './proposals.js';
import { CodeCaptureReader } from './captures.js';
import { CodeGitHubService } from './github.js';
import type { GitHubConfig } from './github-client.js';

/** One Code capability; immutable proposals and machine commands retain separate records. */
export class CodeService extends CodeCommandService implements Code {
  private proposalStore!: CodeProposalService;
  private captureReader!: CodeCaptureReader;
  readonly github: CodeGitHubService;
  constructor(
    state: State,
    scope: Scope,
    sessions: Sessions,
    artifacts: Artifacts,
    github?: GitHubConfig,
  ) {
    super(state, scope, sessions);
    this.github = new CodeGitHubService(state, scope, github);
    const initializeBase = this.initialize.bind(this);
    this.initialize = async () => {
      await initializeBase();

      this.captureReader = new CodeCaptureReader(state, scope, sessions);
      try {
        this.proposalStore = await createService(
          new CodeProposalService(this, state, scope, sessions, artifacts),
        );
        await this.github.initialize();
      } catch (error) {
        await this.close();
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
  override async close(): Promise<void> {
    this.captureReader?.close();
    this.proposalStore?.close();
    super.close();
    await this.github.close();
  }
}
