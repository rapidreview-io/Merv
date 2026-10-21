import { added, browse, log, raw } from './browse.js';
import type { CodeBrowsed } from './models.js';
import { createService, type Scope, type State, type Transaction } from '@merv/contracts';
import { retireGitHubConnections } from './github-retirement.js';
import { declareManagedProject } from './store/managed.js';
import {
  CodeStore,
  type CodeStoreConfig,
  type CodeStoreHooks,
  type FaultPoint,
} from './store/operations.js';
import { CodeRepositories, type CodeRepositoryConfig } from './store/repository.js';
import { CodeUnitStore } from './units.js';
import { CodeWriterService } from './writers.js';
import { CodeGitRemote } from './store/http.js';

export interface CodeConfiguration {
  finalizeGraceSeconds?: number;
  repositories: CodeRepositoryConfig;
}

/**
 * What the owner of work units lends the repository store: how history arriving or a binding
 * or writer changing changes its units, which of its sessions hold a workspace, and coordinated operations.
 */
export interface CodeStorePort extends Pick<CodeStoreHooks, 'workspaces'> {
  network<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * A project's history or binding (no unit) or one unit's writer changed, in the mutation's
   * transaction.
   */
  changed(tx: Transaction, projectId: string, unitId?: string): Promise<void>;
}
/** The deployment's repository storage settings and fault injection seam. */
export interface CodeStoreOptions {
  config?: Partial<Omit<CodeStoreConfig, 'root'>>;
  fault?: (point: FaultPoint) => void;
}
/** A started repository store; its opener closes it. */
export interface CodeStoreHandle {
  store: CodeStore;
  /** Takes back the port's `changed`: the opener calls it as it starts to close. */
  release(): void;
}

/** Durable Git facts and operations. Work-unit policy is supplied by its callers. */
export class CodeService {
  readonly units: CodeUnitStore;
  readonly writers: CodeWriterService;
  readonly repositories: CodeRepositories;
  readonly gitRemote: CodeGitRemote;

  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    config: CodeConfiguration,
  ) {
    this.writers = new CodeWriterService(state, scope, config.finalizeGraceSeconds ?? 900);
    this.units = new CodeUnitStore(state, scope, this.writers);
    this.repositories = new CodeRepositories(config.repositories);
    this.gitRemote = new CodeGitRemote(state, scope, this.repositories, this.writers);
  }

  async initialize(): Promise<void> {
    try {
      await createService(this.units);
      await retireGitHubConnections(this.state);
      await this.repositories.open();
      await this.gitRemote.initialize();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * Build and start the repository store, once the owner of work units can answer
   * their callbacks: a start first finishes what a crash left, which may derive units again.
   */
  async openStore(port: CodeStorePort, options: CodeStoreOptions = {}): Promise<CodeStoreHandle> {
    // Lent from the start: what the store's start finishes may move writers.
    const release = this.writers.lend(port);
    try {
      return { ...(await this.startStore(port, options)), release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async startStore(port: CodeStorePort, options: CodeStoreOptions) {
    const { writers, repositories } = this;
    // Published only once it holds the writer lock and has finished what a crash left.
    const store = new CodeStore(
      this.state,
      this.scope,
      { ...repositories.config, ...options.config },
      {
        changed: (tx, projectId) => writers.changed(tx, projectId),
        workspaces: (projectId, tx) => port.workspaces(projectId, tx),
        fenced: (tx, fence, kind, begin, ownEnd) => writers.fenced(tx, fence, kind, begin, ownEnd),
        advanced: (tx, fence, input) => writers.advanced(tx, fence, input),
        quarantined: (tx, fence, id) => writers.quarantined(tx, fence, id),
        maintained: async () => {
          await this.gitRemote.recover();
          await writers.expire();
        },
      },
      repositories,
      options.fault,
    );
    await store.initialize();
    writers.wake = () => store.wake();
    return { store };
  }

  /** One commit's folder or file of a project's code; the caller has read the project. */
  browse(projectId: string, commit: string, path: string): Promise<CodeBrowsed> {
    return browse(this.repositories, projectId, commit, path);
  }
  /** One file's bytes as they are; the caller has read the project. */
  raw(projectId: string, commit: string, path: string): Promise<Buffer> {
    return raw(this.repositories, projectId, commit, path);
  }
  /** One commit's history, newest first; the caller has read the project. */
  log(projectId: string, commit: string, options: { limit?: number; path?: string }) {
    return log(this.repositories, projectId, commit, options);
  }
  /** The commits `head` adds over `base`. */
  added(projectId: string, head: string, base: string | null) {
    return added(this.repositories, projectId, head, base);
  }

  /** A project Code initializes its own repository for; the caller authorized it. */
  declareManaged(tx: Transaction, projectId: string): Promise<void> {
    return declareManagedProject(tx, projectId);
  }

  async close(): Promise<void> {
    this.units.close();
    this.writers.close();
    await this.repositories.close(45_000);
  }
}

declare module 'cordis' {
  interface Context {
    code: CodeService;
  }
}
