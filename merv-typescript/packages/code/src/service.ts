import { createService, type Scope, type State, type Transaction } from '@merv/contracts';
import { CodeGitHubService } from './github.js';
import type { GitHubConfig } from './github-client.js';
import { declareManagedProject } from './store/managed.js';
import {
  CodeMirrorService,
  GitMirrorTransport,
  type CodeMirrorConfig,
  type MirrorTransport,
} from './store/mirror.js';
import {
  CodeStore,
  type CodeImportRemote,
  type CodeStoreConfig,
  type CodeStoreHooks,
  type FaultPoint,
} from './store/operations.js';
import { CodeRepositories, type CodeRepositoryConfig } from './store/repository.js';
import { CodeUnitStore } from './units.js';
import { CodeWriterService } from './writers.js';

export interface CodeConfiguration {
  finalizeGraceSeconds?: number;
  repositories: CodeRepositoryConfig;
}

/**
 * What the owner of work units lends the repository store: how history arriving or a binding
 * or writer changing changes its units, which of its sessions hold a workspace, and the lane
 * every GitHub call it waits for at unload runs in.
 */
export interface CodeStorePort extends Pick<CodeStoreHooks, 'imported' | 'workspaces'> {
  network<T>(operation: () => Promise<T>): Promise<T>;
  /** A project's binding (no unit) or one unit's writer changed, in the mutation's transaction. */
  changed(tx: Transaction, projectId: string, unitId?: string): Promise<void>;
}
/** The deployment's settings of the store and the mirror, and what a test replaces in them. */
export interface CodeStoreOptions {
  config?: Partial<Omit<CodeStoreConfig, 'root'>>;
  /** Replaces the linked GitHub repository as the place an import reads from. */
  remote?: CodeImportRemote;
  fault?: (point: FaultPoint) => void;
  /** Replaces the linked GitHub repository as the place work is published to. */
  mirror?: MirrorTransport;
  mirrorConfig?: Partial<CodeMirrorConfig>;
}
/** A started store, its mirror, and the transport both publish with; their opener closes them. */
export interface CodeStoreHandle {
  store: CodeStore;
  mirror: CodeMirrorService;
  transport: MirrorTransport;
  /** Takes back the port's `changed`: the opener calls it as it starts to close. */
  release(): void;
}

/** Durable Git facts and operations. Work-unit policy is supplied by its callers. */
export class CodeService {
  readonly units: CodeUnitStore;
  readonly writers: CodeWriterService;
  readonly github: CodeGitHubService;
  readonly repositories: CodeRepositories;

  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    config: CodeConfiguration,
    github?: GitHubConfig,
  ) {
    this.writers = new CodeWriterService(state, scope, config.finalizeGraceSeconds ?? 900);
    this.units = new CodeUnitStore(state, scope, this.writers);
    this.github = new CodeGitHubService(state, scope, github);
    this.repositories = new CodeRepositories(config.repositories);
  }

  async initialize(): Promise<void> {
    try {
      await createService(this.units);
      await this.github.initialize();
      await this.repositories.open();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * Build and start the repository store and its mirror, once the owner of work units can answer
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
    const { github, writers, repositories } = this;
    // Published only once it holds the writer lock and has finished what a crash left.
    const store = new CodeStore(
      this.state,
      this.scope,
      { ...repositories.config, ...options.config },
      {
        imported: (tx, projectId) => port.imported(tx, projectId),
        workspaces: (projectId, tx) => port.workspaces(projectId, tx),
        fenced: (tx, fence, kind, begin) => writers.fenced(tx, fence, kind, begin),
        advanced: (tx, fence, input) => writers.advanced(tx, fence, input),
        quarantined: (tx, fence, id) => writers.quarantined(tx, fence, id),
        maintained: () => writers.expire(),
      },
      repositories,
      // An import reads GitHub as the administrator who asked, with a token that ends with the call.
      options.remote ?? {
        read: (caller, use, expected) =>
          port.network(() => github.importRemote.read(caller, use, expected)),
      },
      options.fault,
    );
    await store.initialize();
    // The server publishes a project's work with no caller: the owner's link and the write
    // automation they turned on are the authorisation, and unlinking is the off switch.
    const transport =
      options.mirror ??
      new GitMirrorTransport(repositories, {
        target: (projectId) => github.mirrorTarget(projectId),
        token: (projectId, use) => port.network(() => github.mirrorToken(projectId, use)),
      });
    const mirror = new CodeMirrorService(
      this.state,
      this.scope,
      repositories,
      transport,
      options.mirrorConfig,
    );
    mirror.initialize();
    return { store, mirror, transport };
  }

  /** A project Code initializes its own repository for; the caller authorized it. */
  declareManaged(tx: Transaction, projectId: string): Promise<void> {
    return declareManagedProject(tx, projectId);
  }

  async close(): Promise<void> {
    this.units.close();
    this.writers.close();
    await this.repositories.close(45_000);
    await this.github.close();
  }
}

declare module 'cordis' {
  interface Context {
    code: CodeService;
  }
}
