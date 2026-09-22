import { createService, type Scope, type State } from '@merv/contracts';
import { CodeGitHubService } from './github.js';
import type { GitHubConfig } from './github-client.js';
import { CodeRepositories, type CodeRepositoryConfig } from './store/repository.js';
import { CodeUnitStore } from './units.js';
import { CodeWriterService } from './writers.js';
import { CodeChanges } from './changes.js';

export interface CodeConfiguration {
  finalizeGraceSeconds?: number;
  repositories?: CodeRepositoryConfig;
}

/** Durable Git facts and operations. Research policy is supplied by its callers. */
export class CodeService {
  readonly changes: CodeChanges;
  readonly units: CodeUnitStore;
  readonly writers: CodeWriterService;
  readonly github: CodeGitHubService;
  readonly repositories?: CodeRepositories;

  constructor(state: State, scope: Scope, config: CodeConfiguration, github?: GitHubConfig) {
    this.changes = new CodeChanges(state);
    this.writers = new CodeWriterService(
      state,
      scope,
      config.finalizeGraceSeconds ?? 900,
      this.changes,
    );
    this.units = new CodeUnitStore(state, scope, this.writers);
    this.github = new CodeGitHubService(state, scope, github);
    if (config.repositories) this.repositories = new CodeRepositories(config.repositories);
  }

  async initialize(): Promise<void> {
    try {
      await createService(this.units);
      await this.github.initialize();
      await this.repositories?.open();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.units.close();
    this.writers.close();
    await this.repositories?.close(45_000);
    await this.github.close();
  }
}

declare module 'cordis' {
  interface Context {
    code: CodeService;
  }
}
