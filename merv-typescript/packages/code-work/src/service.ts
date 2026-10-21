import { bootMaintenance } from '@merv/contracts/maintenance';
import { configureWorkRepository, projectCheck } from './check-configuration.js';
import { parseCodeInput } from '@merv/code/input';
import type { CodeService as CodeUtility, CodeStoreOptions } from '@merv/code/service';
import type { CodeStore } from '@merv/code/store/operations';
import type { Caller, Reviews, Scope, Sql, State, Transaction, Workflows } from '@merv/contracts';
import type { CodeRepositoryPrepareInput } from './models.js';
import {
  check,
  CODE_DRIVER,
  NATIVE_CODE_DRIVER,
  createService,
  digest,
  forRead,
  mapAsync,
  MervError,
} from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import { CodeBaseService } from './bases.js';
import { checkedCapture, CodeCaptureReader } from './captures.js';
import { CodeCommandService } from './commands.js';
import { beyondMain, MainLanding } from './landing.js';
import { CodeWorkspaceProtocol } from './protocol.js';
import { PublicationHost } from './publication-host.js';
import { CodePublicationService } from './publications.js';
import { migrateRepositorySync, reconcileRepository } from './repository-sync.js';
import { repositoryPrepareSchema } from './repository-setup.js';
import { CodeRunningReader } from './running.js';
import type { Code, ResolutionWorkCreator } from './types.js';
import { CodeUnitService } from './units.js';
import { CodeSubmissionService, type SubmissionStorage } from './submissions.js';
import { acceptance, pin, unitColumns, type UnitRow } from './unit-store.js';
import type { CodeWriterService } from '@merv/code/writers';
import type { CodeAcceptedSince } from './models.js';

/** The tool registry's presentation of guidance (Tools.guidance). */
interface Guidance {
  guidance<T>(caller: Caller, value: T): T;
}

export type { CodeStoreOptions };

/**
 * Refusals at a lease that only mean "not yet": a base still pending, contested, merging or
 * needing an operator, or a last writer still handing over what it left. Each is published
 * where blocked work is shown and says nothing against the work, so it is marked a wait.
 */
const waits = new Set([
  'code_base_pending',
  'code_base_wait',
  'code_base_admission',
  'code_merge_conflict',
  'code_base_blocked',
  'code_quarantined',
  'code_dependencies_changed',
  'code_writer_busy',
  'code_capture_quarantined',
]);
/** Rethrows a refusal, marked as a wait when it is one of those. */
function refuse(error: unknown): never {
  if (error instanceof MervError && waits.has(error.code)) error.wait = true;
  throw error;
}

export class CodeService implements Code {
  /** The durable runner commands; this service adds Code's admission to their completion. */
  private readonly commands: CodeCommandService;
  private captureReader!: CodeCaptureReader;
  submissions!: CodeSubmissionService;
  private submissionStorage?: SubmissionStorage;
  bindSubmissionStorage(storage: SubmissionStorage) {
    this.submissionStorage = storage;
  }
  private unitStore!: CodeUnitService;
  private readonly writerStore: CodeWriterService;
  // Set by initialize(); close() also runs after an initialization that failed half-way.
  private store!: CodeStore;
  private baseStore!: CodeBaseService;
  private landing?: MainLanding;
  private protocol!: CodeWorkspaceProtocol;
  private publicationStore!: CodePublicationService;
  private publicationHost!: PublicationHost;
  private readonly board: CodeRunningReader;
  private publicationClosed = false;
  private releaseProvenance?: () => void;
  private releaseChanges?: () => void;
  private publicationTimer?: NodeJS.Timeout;
  private networkOperations = new Set<Promise<unknown>>();
  private network<T>(operation: () => Promise<T>): Promise<T> {
    if (this.publicationClosed)
      return Promise.reject(new MervError('code_unavailable', 'Code is unavailable', 503));
    const pending = operation();
    this.networkOperations.add(pending);
    void pending.then(
      () => this.networkOperations.delete(pending),
      () => this.networkOperations.delete(pending),
    );
    return pending;
  }
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly sessions: Sessions,
    private readonly workflows: Workflows,
    private readonly reviews: Reviews,
    private readonly utility: Pick<
      CodeUtility,
      | 'writers'
      | 'units'
      | 'openStore'
      | 'declareManaged'
      | 'repositories'
      | 'gitRemote'
      | 'browse'
      | 'raw'
      | 'log'
      | 'added'
    >,
    private readonly repositories: CodeStoreOptions = {},
    /** The plugin's config: whether accepted work lands on main (landing.ts). */
    private readonly options: { mainLanding?: boolean } = {},
  ) {
    this.commands = new CodeCommandService(state, scope, sessions);
    this.writerStore = utility.writers;
    this.board = new CodeRunningReader(state, scope, workflows, {
      unit: (caller, unitId, tx) => this.unitStore.records.unit(caller, unitId, tx),
      bases: () => this.baseStore,
      receipt: (sql, projectId, instanceId) =>
        this.commands.newestReceipt(sql, projectId, instanceId),
    });
  }
  async initialize(): Promise<void> {
    await this.commands.initialize();
    const { state, scope, sessions, utility, repositories } = this;
    this.submissions = new CodeSubmissionService(
      state,
      scope,
      sessions,
      this.writerStore,
      this.reviews,
      {
        verifySubmission: (...args) => {
          check(this.submissionStorage, 'code_unavailable', 'Git remote is unavailable', 503);
          return this.submissionStorage.verifySubmission(...args);
        },
        materializeSubmission: (...args) => {
          check(this.submissionStorage, 'code_unavailable', 'Git remote is unavailable', 503);
          return this.submissionStorage.materializeSubmission(...args);
        },
      },
      (tx, projectId, value) => this.unitStore.acceptFrozen(tx, projectId, value),
    );
    this.bindSubmissionStorage(utility.gitRemote);
    await this.submissions.initialize();
    this.captureReader = new CodeCaptureReader(
      state,
      scope,
      sessions,
      this.writerStore,
      async (projectId, base, head) => await this.store.stats(projectId, base, head),
      this.submissions,
    );
    try {
      this.unitStore = await createService(
        new CodeUnitService(
          state,
          scope,
          this.workflows,
          this,
          this.writerStore,
          utility.units,
          sessions,
          this.reviews,
        ),
      );
      // Reviews asks Code who contributed to a resolution before it lets anyone review it.
      this.releaseProvenance = this.reviews
        .provenance('code')
        .register((projectId, subjectId, tx) =>
          this.unitStore.reviewProvenance(projectId, subjectId, tx),
        );
      // Bases come first: what the store's start finishes may derive units, which merge.
      const bases = new CodeBaseService(state, utility.repositories, {
        changed: async (tx, projectId) => {
          await this.unitStore.changed(tx, projectId);
          // A base that reached an end may be the one a landing on main waits for.
          this.landing?.soon(projectId);
        },
        sponsors: (tx, projectId) => this.unitStore.baseSponsors(tx, projectId),
        serviceWork: sessions.serviceWork,
        resolved: async (tx, projectId, key, commit) => {
          await this.unitStore.records.retainBaseResult(tx, projectId, key, commit);
          this.store?.wake();
        },
        message: async (sql, projectId, key) =>
          (await this.landing?.message(sql, projectId, key)) ??
          (await this.mergeMessage(sql, projectId, key)),
      });
      await bases.initialize();
      this.unitStore.bases = bases;
      this.baseStore = bases;
      const opened = await utility.openStore(
        {
          changed: (tx, projectId, unitId) => this.unitStore.changed(tx, projectId, unitId),
          workspaces: async (projectId, tx) => [
            ...new Set([
              ...(await sessions.holdingWorkspace(projectId, CODE_DRIVER, tx)),
              ...(await sessions.holdingWorkspace(projectId, NATIVE_CODE_DRIVER, tx)),
            ]),
          ],
          network: (operation) => this.network(operation),
        },
        repositories,
      );
      this.store = opened.store;
      this.releaseChanges = opened.release;
      this.publicationHost = new PublicationHost(
        this.reviews,
        utility.repositories,
        this.writerStore,
        { units: this.unitStore },
      );
      this.publicationStore = new CodePublicationService(
        state,
        scope,
        utility.units,
        this.publicationHost,
      );
      this.unitStore.publications = this.publicationStore;
      const landing = new MainLanding(
        state,
        this.unitStore,
        utility.repositories,
        this.workflows,
        !!this.options.mainLanding,
      );
      await landing.initialize();
      this.landing = this.unitStore.landing = this.publicationStore.landing = landing;
      this.protocol = new CodeWorkspaceProtocol(
        state,
        sessions,
        this.writerStore,
        opened.store,
        utility.gitRemote,
        this.submissions,
      );
      bases.start();
      await this.publicationStore.initialize();
      await migrateRepositorySync(state);
      this.submissions.start();
      // A tick while a pass runs starts nothing, and closing stops the pass.
      let pass: Promise<unknown> | undefined;
      this.publicationTimer = setInterval(() => {
    if (bootMaintenance.active) return;
        pass ??= this.network(async () => {
          await landing.tick();
          await this.publicationStore.syncDue(() => this.publicationClosed);
        })
          .catch(() => undefined)
          .finally(() => (pass = undefined));
      }, 30_000);
      // What a restart left to land, including every acceptance from before landing existed.
      void this.network(() => landing.tick()).catch(() => undefined);
      this.publicationTimer.unref();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  expectSubmission: Code['expectSubmission'] = (...args) => this.submissions.expect(...args);
  approveSubmission: Code['approveSubmission'] = async (caller, input, tx) => {
    await this.unitStore.validateFrozenApproval(caller, input, tx);
    await this.submissions.approve(caller, input, tx);
  };
  capture: Code['capture'] = (...args) => this.captureReader.capture(...args);
  captures: Code['captures'] = (...args) => this.captureReader.captures(...args);
  checkCapture: Code['checkCapture'] = async (caller, ref, origin, tx) =>
    checkedCapture(await this.capture(caller, ref, tx), caller.projectId, origin);
  list: Code['list'] = (...args) => this.commands.list(...args);
  operation: Code['operation'] = (...args) => this.commands.operation(...args);
  publications: Code['publications'] = (caller) => this.publicationStore.publications(caller);
  syncPublications: Code['syncPublications'] = (caller) =>
    this.network(() => this.publicationStore.syncPublications(caller));
  publicationDetails: Code['publicationDetails'] = (...args) =>
    this.network(() => this.publicationStore.publicationDetails(...args));
  /** The runner that executes a project check. */
  bindChecks(checks: import('./check-types.js').SandboxChecks): () => void {
    const bases = this.baseStore;
    bases.checks = checks;
    return () => {
      if (bases.checks === checks) bases.checks = undefined;
    };
  }
  /** Code's guidance names each action by its address (units.ts); every read that carries it
   *  says it as its caller calls it (Tools.guidance) once the tool registry is bound. */
  private said: Guidance['guidance'] = (_caller, value) => value;
  bindGuidance(tools: Guidance): () => void {
    this.said = (caller, value) => tools.guidance(caller, value);
    return () => (this.said = (_caller, value) => value);
  }
  bindServiceTasks(provider: ResolutionWorkCreator): () => void {
    this.unitStore.resolutionTasks = provider;
    // The startup pass did everything else; only a conflict needs the provider it lacked.
    void this.unitStore.reconcileAll(true).catch(() => undefined);
    return () => {
      if (this.unitStore.resolutionTasks === provider) this.unitStore.resolutionTasks = undefined;
    };
  }

  declareUnit: Code['declareUnit'] = (...args) => this.unitStore.declareUnit(...args);
  acceptUnit: Code['acceptUnit'] = (...args) => this.unitStore.acceptUnit(...args);
  publishOnAcceptance: Code['publishOnAcceptance'] = (...args) =>
    this.unitStore.publishOnAcceptance(...args);
  /**
   * The accepted units whose code the project's main does not contain yet. It takes no
   * transaction, because the house rule is that Git never runs inside one: the candidates are
   * read on their own and Git is asked afterwards (beyondMain).
   */
  async acceptedSince(caller: Caller): Promise<CodeAcceptedSince> {
    caller = structuredClone(caller);
    // A pure read: a snapshot, never the writer lock.
    const { main, candidates } = await forRead(this.state, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await this.unitStore.records.candidatesOf(tx, caller.projectId);
    });
    const beyond = await beyondMain(
      this.utility.repositories,
      caller.projectId,
      main,
      candidates.map((item) => item.commit),
    );
    const missing = (quarantined: boolean) =>
      candidates
        .filter((item) => beyond.has(item.commit) && !!item.quarantined === quarantined)
        .map((item) => item.unitId)
        .sort();
    const [unitIds, quarantined] = [missing(false), missing(true)];
    return {
      unitIds,
      quarantined,
      main,
      hash: digest({ formatVersion: 1, main, unitIds, quarantined }),
    };
  }
  baseStatus: Code['baseStatus'] = (...args) => this.unitStore.baseStatus(...args);
  async pinBase(...[caller, input, tx]: Parameters<Code['pinBase']>) {
    const pin = await this.unitStore.pinBase(caller, input, tx).catch(refuse);
    // A writable checkout's lease becomes the unit's next writer generation in Code.
    if (input.writer) await this.writerStore.reserveWriter(caller, input, tx).catch(refuse);
    return pin;
  }
  basePin: Code['basePin'] = (...args) => this.unitStore.records.basePin(...args);
  resumesFrom: Code['resumesFrom'] = (...args) => this.unitStore.records.resumesFrom(...args);
  /** Plugin wiring, not part of the Code contract: no other plugin reconciles Code's view. */
  reconcileAll = () => this.unitStore.reconcileAll();
  async transitioned(...args: Parameters<CodeUnitService['transitioned']>) {
    await this.unitStore.transitioned(...args);
    // Only a success carries an acceptance, whose retained ref the store takes up after this.
    if (args[0].data.settled !== false) this.store.wake();
  }
  controlBase: Code['controlBase'] = (...args) => this.baseStore.control(this.scope, ...args);
  async requireLeasable(
    caller: Caller,
    input: { unitId: string; writer: boolean },
    tx: Transaction,
  ): Promise<void> {
    await this.scope.require(caller, 'read', tx);
    if (input.writer) await this.submissions.requireSettled(caller.projectId, input.unitId, tx);
    // A board's guidance asks this of each unit more than once; one snapshot answers once.
    const blocked = await this.state.remember(
      `code-work:leasable:${caller.projectId}:${input.unitId}:${input.writer}`,
      async () => {
        const base = await this.baseStatus(caller, input.unitId, tx);
        if (base.status === 'blocked') return base.blockers[0]!;
        return input.writer
          ? (await this.writerStore.writerStatus(caller, input.unitId, tx)).blocked
          : null;
      },
    );
    if (blocked) refuse(new MervError(blocked.code, blocked.message, 409));
  }
  /** An administrator's: every admitted upload of the unit is first given the chance to finish. */
  async fenceUnit(caller: Caller, input: unknown) {
    const store = this.store;
    caller = structuredClone(caller);
    await this.scope.require(caller, 'admin');
    await store.maintain(false);
    const status = await this.state.transaction(async (tx) => {
      check(!this.publicationClosed, 'code_unavailable', 'Code is unavailable', 503);
      return await this.writerStore.fence(caller, input, tx);
    });
    // What the fenced generation had only begun to send is kept where no route serves it.
    await store.maintain();
    return status;
  }
  /** The Running page's reads, each on the page's snapshot (running.ts). */
  runningHolds: Code['runningHolds'] = (caller) => this.board.holds(caller);
  runningChecks: Code['runningChecks'] = (caller) => this.board.checks(caller);
  runningPanel: Code['runningPanel'] = (caller, key) => this.board.panel(caller, key);
  runningCode: Code['runningCode'] = (caller, keys) => this.board.sections(caller, keys);
  hosted: Code['hosted'] = (...args) => this.utility.units.hosted(...args);
  async ensureRepository(caller: Caller, tx: Transaction): Promise<void> {
    await this.scope.require(caller, 'write', tx);
    if (!(await this.utility.units.hosted(caller, tx)))
      await this.projectCreated(caller.projectId, tx);
  }
  async projectCreated(projectId: string, tx: Transaction): Promise<void> {
    await this.utility.declareManaged(tx, projectId);
    this.store.wake();
  }
  unit: Code['unit'] = async (caller, ...args) =>
    this.said(caller, await this.unitStore.records.unit(caller, ...args));
  /**
   * What a merge of accepted work says it merges: the tasks and experiments whose accepted
   * commits are its members, by their names, which never change, so a repeat makes the same
   * commit. A member no unit accepted (main, an earlier merge) is counted, not named.
   */
  private async mergeMessage(sql: Sql, projectId: string, key: string): Promise<string | null> {
    const base = await sql.get<{ members_json: string }>(
      'SELECT members_json FROM code_bases WHERE project_id=? AND base_key=?',
      projectId,
      key,
    );
    if (!base) return null;
    const members = JSON.parse(base.members_json) as string[];
    const ids = (
      await sql.all<{ unit_id: string }>(
        `SELECT unit_id FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL AND (acceptance_json::jsonb #>> '{code,commit}') IN (${members.map(() => '?').join(',')}) ORDER BY accepted_at,unit_id`,
        projectId,
        ...members,
      )
    ).map((row) => row.unit_id);
    if (!ids.length) return null;
    const names = await this.state.snapshotTransaction(async (tx) => {
      const found: string[] = [];
      for (const id of ids)
        found.push((await this.workflows.relations(projectId, id, tx))?.instance.name ?? id);
      return found;
    });
    const rest = members.length - ids.length;
    return `Merge ${names.join(' + ')}${rest > 0 ? ` + ${rest} more` : ''}`;
  }
  /** The commit `ref` names: main (the default), a unit's accepted code or newest head, or a commit. */
  private async commitOf(caller: Caller, input: { ref?: string }) {
    const ref = input.ref?.trim() || 'main';
    const commit = await this.state.snapshotTransaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) return ref;
      if (ref === 'main') return (await this.utility.units.project(tx, caller.projectId))?.main.oid;
      const unit = await this.unit(caller, ref, tx);
      return unit.acceptance?.reference ?? unit.canonicalHead;
    });
    if (!commit)
      throw new MervError(
        'code_ref_empty',
        ref === 'main' ? 'This project has no main yet' : `${ref} has no code yet`,
        404,
      );
    return { ref, commit };
  }
  /**
   * A folder or file of the project's code, as of `ref`: main (the default), a task or
   * experiment by its id (its accepted code, or else the newest Code admitted for it), or a commit.
   */
  async files(caller: Caller, input: { ref?: string; path?: string }) {
    const { ref, commit } = await this.commitOf(caller, input);
    return { ref, ...(await this.utility.browse(caller.projectId, commit, input.path ?? '')) };
  }
  async raw(caller: Caller, input: { ref?: string; path: string }) {
    const { commit } = await this.commitOf(caller, input);
    return await this.utility.raw(caller.projectId, commit, input.path);
  }
  /**
   * The history of `ref`, newest first, each commit with the task or experiment whose work it is:
   * the unit whose accepted (or newest) head adds it over the base that unit was built on. Git
   * holds no record names, so this is where a reader of history learns where a change came from.
   */
  async history(caller: Caller, input: { ref?: string; path?: string; limit?: number }) {
    const { ref, commit } = await this.commitOf(caller, input);
    const entries = await this.utility.log(caller.projectId, commit, input);
    // The newest 200 units, as code.read status lists them, with their heads and bases (not their
    // derived status) read in one snapshot, which the Git below never holds. Oldest acceptance
    // first, so a commit is the work of the unit that first carried it.
    const units = await this.state.read(async (sql) =>
      mapAsync(
        await sql.all<UnitRow>(
          `SELECT * FROM (SELECT ${unitColumns} FROM code_units WHERE project_id=? ORDER BY declared_at DESC,unit_id LIMIT 200) u ORDER BY accepted_at,declared_at DESC,unit_id`,
          caller.projectId,
        ),
        async (row) => ({
          id: row.unit_id,
          base: pin(row)?.reference ?? null,
          head:
            acceptance(row)?.reference ??
            (await this.writerStore.facts(sql, caller.projectId, row.unit_id)).canonicalHead,
        }),
      ),
    );
    const owner = new Map<string, string>();
    const wanted = new Set(entries.map((entry) => entry.oid));
    for (const { id, base, head } of units) {
      if (owner.size >= wanted.size) break;
      if (!head) continue;
      for (const oid of await this.utility.added(caller.projectId, head, base))
        if (wanted.has(oid) && !owner.has(oid)) owner.set(oid, id);
    }
    const named = new Map<string, { kind: string; title: string }>();
    await this.state.snapshotTransaction(async (tx) => {
      for (const id of new Set(owner.values())) {
        const found = await this.workflows.relations(caller.projectId, id, tx).catch(() => null);
        named.set(id, {
          kind: found?.instance.workflow ?? 'work',
          title: found?.instance.name ?? id,
        });
      }
    });
    return {
      ref,
      commit,
      commits: entries.map((entry) => {
        const id = owner.get(entry.oid);
        return id ? { ...entry, unit: { id, ...named.get(id)! } } : entry;
      }),
    };
  }
  async status(caller: Caller) {
    const status = await this.unitStore.status(caller);
    const publication = status.project
      ? {
          publication: {
            records: await this.publicationStore.publications(caller),
          },
        }
      : {};
    const technical = await this.store.describe(caller.projectId);
    const configuredCheck = await this.state.read((sql) => projectCheck(sql, caller.projectId));
    return this.said(caller, {
      ...status,
      ...publication,
      bases: await this.state.read((sql) => this.baseStore.records(sql, caller.projectId)),
      landing: await this.landing!.status(caller.projectId),
      ...technical,
      store: { ...technical.store, limits: { ...technical.store.limits, check: configuredCheck } },
    });
  }
  /** A project from before Code initialized on creation gets its repository on configuration, as on
   *  new work, once the caller is known to be an administrator: nobody else's call initializes
   *  or maintains anything. */
  private async administered(caller: Caller) {
    await this.state.transaction(async (tx) => {
      await this.store.administrator(caller, tx);
      await this.ensureRepository(caller, tx);
    });
    await this.store.maintain(false);
  }
  async prepareRepository(caller: Caller, value: CodeRepositoryPrepareInput) {
    caller = structuredClone(caller);
    const input = parseCodeInput(repositoryPrepareSchema, value);
    await this.administered(caller);
    return reconcileRepository(
      this.state,
      this.utility.repositories,
      this.unitStore,
      caller,
      input,
    );
  }
  configureRepository = async (caller: Caller, input: unknown) =>
    configureWorkRepository(this.state, this.scope, this.store, caller, input);
  /**
   * The second workspace protocol as the API forwards it: opaque bodies and bundle bytes.
   * Absent once Code Work is closing, which the API answers as unavailable.
   */
  get v2() {
    return this.publicationClosed ? undefined : this.protocol;
  }
  get gitRemote() {
    return this.utility.gitRemote;
  }
  async close(): Promise<void> {
    this.publicationClosed = true;
    this.releaseProvenance?.();
    this.releaseProvenance = undefined;
    clearInterval(this.publicationTimer);
    // Stop scheduling immediately, then join the whole pass, including its final journal write.
    const landing = this.landing?.close();
    // No new merge starts from here; one that is running is waited for below, because every
    // read must be refused before this method first yields.
    const merging = this.baseStore?.close();
    this.captureReader?.close();
    await this.submissions?.close();
    this.unitStore?.close();
    this.releaseChanges?.();
    this.commands.close();
    // Finish admitted local operations before releasing repository ownership.
    await Promise.all([
      merging,
      landing,
      Promise.allSettled([...this.networkOperations]),
      this.store?.close(),
    ]);
  }
}
