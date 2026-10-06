import {
  check,
  newId,
  MervError,
  type Caller,
  type DelegationSource,
  type Sql,
  type Transaction,
} from '@merv/contracts';
import { delegationEnd } from '@merv/scope/rules';
import type { FleetAllocation, FleetOwner } from '@merv/fleet/types';
import { tokenDigest } from '@merv/identity/credentials';
import type {
  PiBootstrap,
  PiCommandRecord,
  PiConversationRecord,
  PiHostRecord,
  PiInterruption,
  PiMove,
  PiMoveBy,
  PiMoveFailure,
  PiSlot,
} from './types.js';
import { active, decode, gone, lost, type PiCore, readyMs, roleOf, roles } from './core.js';

/** A current slot this close to its deadline is replaced by a fresh one of its machine (T10). */
const rolloverMs = 15 * 60_000;
/** A rollover Fleet refused is tried again this long after: three times in its window. */
const rolloverRetryMs = 5 * 60_000;
/** A move holds two machines, so it starts only with room left for someone else's first. */
const moveRoom = 3;

/** Each person's host: renting its machines, moving and ending it, and the reconciler that keeps
 * it in step with Fleet. Fleet's owner callbacks (payer, valid, bootstrap, observe) are here. */
export class PiHosts implements FleetOwner {
  readonly sourcePermission = 'read' as const;
  /** Owner ids Fleet is admitting now, with their person: valid() and payer() answer for a slot
   * before its host records it. */
  private readonly renting = new Map<string, string>();
  /** The Pi host identity, which rents every slot; never the person. */
  private renter?: Caller;
  /** The reconciling pass under way, which close() waits for. */
  pending?: Promise<void>;
  constructor(private readonly core: PiCore) {}
  /** Each open page of the conversations sharing the host re-reads once the transaction commits
   * (announce). */
  async saveHost(tx: Transaction, host: PiHostRecord): Promise<void> {
    const previous = await this.core.host(tx, host.id);
    const live = host.status === 'live' ? roles.flatMap((role) => host[role] ?? []) : [];
    for (const slot of live) {
      const old =
        previous &&
        roles
          .map((role) => previous[role])
          .find((value) => value?.allocationId === slot.allocationId && value.epoch === slot.epoch);
      if (!old || old.expiresAt !== slot.expiresAt) await this.syncWorkerCredential(tx, host, slot);
    }
    if (previous)
      for (const role of roles) {
        const slot = previous[role];
        if (slot && !live.some((current) => current.allocationId === slot.allocationId))
          await this.revokeWorkerCredential(tx, previous, slot);
      }
    host.revision++;
    await tx.run(
      'INSERT INTO pi_hosts(id,key,status,created_at,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json',
      host.id,
      host.key,
      host.status,
      host.createdAt,
      JSON.stringify(host),
    );
    for (const { id } of await this.sharing(tx, host.userId, host.key)) this.core.sharers.add(id);
  }
  /** The person's conversations that share the host `key`. */
  private async sharing(sql: Sql, userId: string, key: string) {
    return (
      await sql.all<{ id: string; project_id: string }>(
        'SELECT id,project_id FROM pi_conversations WHERE user_id=?',
        userId,
      )
    ).filter(({ project_id }) => this.core.key(userId, project_id) === key);
  }
  /** A move, stamped at its outcome, joins the person's last day of moves; an agent's cut-over
   * also makes its machine where a new host starts (`sticky`). */
  private async record(tx: Transaction, key: string, move: Omit<PiMove, 'at'>): Promise<void> {
    const person = await this.core.person(tx, key);
    person.moves.push({ at: this.core.time(), ...move });
    if (move.by === 'agent' && move.outcome === 'moved') person.sticky = move.to;
    await this.core.savePerson(tx, person);
  }
  private async syncWorkerCredential(
    tx: Transaction,
    host: PiHostRecord,
    slot: PiSlot,
  ): Promise<void> {
    const allocation = await this.allocation(slot.allocationId, tx);
    if (!allocation) return;
    // Fleet can reset its deadline once when a queued rental starts. Its two phases each
    // last at most 24 hours, so the same worker key has a fixed outer limit of 48 hours.
    const hardDeadline = new Date(Date.parse(allocation.createdAt) + 2 * 86_400_000).toISOString();
    const tokenHash = tokenDigest(this.core.workerToken(host.id, slot));
    const credential = await this.core.credentials.adopt(
      {
        owner: 'pi',
        subject: this.core.workerSubject(host, slot),
        kind: 'pi-worker',
        tokenHash,
        expiresAt: slot.expiresAt,
        hardDeadline,
      },
      tx,
    );
    if (
      credential.expiresAt &&
      credential.expiresAt < slot.expiresAt &&
      credential.expiresAt > this.core.time() &&
      !credential.revokedAt
    )
      await this.core.credentials.renew(tokenHash, 'pi', slot.expiresAt, tx);
  }
  private revokeWorkerCredential(tx: Transaction, host: PiHostRecord, slot: PiSlot) {
    return this.core.revokeCredential(tx, this.core.workerToken(host.id, slot));
  }
  /** The conversation's live host and the allocation of the slot serving its new turns. */
  async machineOf(tx: Transaction, conversation: PiConversationRecord) {
    const host = await this.core.liveHost(
      tx,
      this.core.key(conversation.userId, conversation.projectId),
    );
    const allocation = host?.current && (await this.allocation(host.current.allocationId, tx));
    return { host, allocation: allocation || null };
  }
  /** T1: the person's live host here, with a current slot for new turns: one is rented when it
   * has none. A host that has idled out is ended, not raced; the next send starts a fresh one. */
  async ensure(
    renter: Caller,
    { userId, projectId }: PiConversationRecord,
    source: DelegationSource,
    tx: Transaction,
    warm = false,
  ): Promise<{ host: PiHostRecord; queued: boolean }> {
    const key = this.core.key(userId, projectId);
    let host = await this.core.liveHost(tx, key);
    if (host) await this.settle(tx, host, renter);
    if (host?.status === 'live' && host.current) {
      const allocation = await this.allocation(host.current.allocationId, tx);
      return { host, queued: allocation?.phase === 'queued' };
    }
    const machine = await this.core.starting(await this.core.person(tx, key), source, tx);
    if (host?.status !== 'live')
      host = {
        id: newId('pih'),
        key,
        userId,
        status: 'live',
        epoch: 0,
        revision: 0,
        current: null,
        next: null,
        draining: null,
        idleSince: null,
        createdAt: this.core.time(),
        ended: null,
      };
    host.current = await this.rent(renter, host, machine, tx);
    // Unused, a warmed host ends after the idle timeout like any other.
    if (warm && !(await this.core.turns(tx, host.id)).length) host.idleSince = this.core.time();
    await this.saveHost(tx, host);
    return { host, queued: true };
  }
  /** The Pi host identity (config.host.credentialEnv) rents every slot in the host project, so a
   * person's project needs no Sandboxes of its own. It only rents: turns read as the person. With
   * the host project unconnected, Fleet refuses a rental as sandbox_not_connected. A key it does
   * not accept is the server's fault, never the person's 401, which would sign them out. */
  async hostCaller(): Promise<Caller> {
    if (this.renter) return this.renter;
    const token = process.env[this.core.config.host!.credentialEnv];
    check(token, 'pi_configuration', 'The Pi host credential is unavailable', 503);
    const actor = await this.core.scope.authenticate(token).catch((error: unknown) => {
      if (error instanceof MervError && error.status === 401) return null;
      throw error;
    });
    check(actor, 'pi_configuration', 'The Pi host credential is not accepted', 503);
    check(
      actor.projectId === this.core.hostProject,
      'pi_configuration',
      'The Pi host credential is outside its project',
      503,
    );
    return (this.renter = {
      actorId: actor.id,
      projectId: actor.projectId,
      credentialId: actor.credential.id,
    });
  }
  /** A new slot on `machine` for the host, requested by the host identity under a new epoch. */
  private async rent(
    renter: Caller,
    host: PiHostRecord,
    machine: string,
    tx: Transaction,
  ): Promise<PiSlot> {
    const epoch = ++host.epoch;
    const id = `${host.id}:${epoch}`;
    this.renting.set(id, host.userId);
    try {
      const allocation = await this.core.fleet.request(
        renter,
        { requestId: id, owner: { kind: 'pi-host', id }, profile: machine },
        tx,
      );
      return {
        allocationId: allocation.id,
        allocationEpoch: allocation.epoch,
        epoch,
        machine,
        expiresAt: allocation.deadlineAt,
        workerId: null,
        enrolledAt: null,
        readyAt: null,
      };
    } finally {
      this.renting.delete(id);
    }
  }
  /** The earliest of the slot's deadline, the source's expiry and `span` from now: none while
   * queued, turnTimeoutSeconds to reach the machine, and the ceiling once claimed. */
  turnEnd(slot: PiSlot, source: DelegationSource, span: number): number {
    return Math.min(this.core.clock() + span, Date.parse(slot.expiresAt), delegationEnd(source));
  }
  /** A turn's time to reach its machine; a queued one waits for capacity without a limit. */
  startMs(queued: boolean): number {
    return queued ? Infinity : this.core.config.turnTimeoutSeconds * 1000;
  }
  /** A claimed turn that showed no progress for turnTimeoutSeconds. One claimed before this
   * process started counts from its first check here. */
  private stalled(turn: PiCommandRecord): boolean {
    if (!turn.workerId) return false;
    const key = `${turn.conversationId}:${turn.id}`;
    if (!this.core.progressAt.has(key)) this.core.progressAt.set(key, this.core.clock());
    return (
      this.core.progressAt.get(key)! + this.core.config.turnTimeoutSeconds * 1000 <=
      this.core.clock()
    );
  }
  /** The host's idle clock starts when the last turn in any of its conversations has ended. */
  async quiet(tx: Transaction, hostId: string | undefined): Promise<void> {
    const host = hostId ? await this.core.host(tx, hostId) : null;
    if (host?.status !== 'live' || host.idleSince || (await this.core.turns(tx, host.id)).length)
      return;
    host.idleSince = this.core.time();
    await this.saveHost(tx, host);
  }
  /** An operator may delete a stuck allocation row; Pi then treats the machine as lost. */
  allocation(id: string, tx?: Transaction): Promise<FleetAllocation | null> {
    return this.core.fleet.inspectOwned(this, id, tx).catch((error: unknown) => {
      if (
        error instanceof MervError &&
        ['fleet_not_found', 'fleet_owner_denied'].includes(error.code)
      )
        return null;
      throw error;
    });
  }

  /** The live host slot an allocation serves; only Pi records a slot's allocation on a host. */
  async owning(allocation: FleetAllocation, tx: Transaction) {
    if (this.core.closed || !this.core.config.enabled || allocation.owner.kind !== 'pi-host')
      return null;
    const [hostId, epoch] = allocation.owner.id.split(':');
    const host = await this.core.host(tx, hostId);
    const role = host?.status === 'live' ? roleOf(host, allocation.id) : undefined;
    const slot = role && host![role];
    return slot && slot.epoch === Number(epoch) ? { host: host!, role: role!, slot } : null;
  }
  /** A host's machines are for its person, whose day's compute they count toward. */
  async payer(_source: DelegationSource, ownerId: string, tx: Transaction): Promise<string | null> {
    return (
      this.renting.get(ownerId) ??
      (await this.core.host(tx, ownerId.split(':')[0]!))?.userId ??
      null
    );
  }
  /** C runs until the host idles out, N until its time to prove ready, D while it has turns. */
  async valid(allocation: FleetAllocation, tx: Transaction): Promise<boolean> {
    if (allocation.owner.kind === 'pi-host' && this.renting.has(allocation.owner.id)) return true;
    const owned = await this.owning(allocation, tx);
    if (!owned) return false;
    if (owned.role === 'current') return !this.core.idleOver(owned.host);
    if (owned.role === 'next') return owned.host.next!.readyBy > this.core.time();
    return (await this.core.turns(tx, owned.host.id)).some(
      (turn) => turn.runtimeId === allocation.id && turn.workerId,
    );
  }

  async bootstrap(allocation: FleetAllocation): Promise<string> {
    this.core.ready();
    return this.core.read(async (tx) => {
      const owned = await this.owning(allocation, tx);
      check(
        owned && (await this.valid(allocation, tx)),
        'pi_runtime_stale',
        'Conversation runtime is stale',
        403,
      );
      const { host, slot } = owned;
      const bootstrap: PiBootstrap = {
        kind: 'pi',
        version: 2,
        baseUrl: new URL(this.core.config.baseUrl!).origin,
        hostId: host.id,
        runtimeId: allocation.id,
        epoch: slot.epoch,
        machine: slot.machine,
        slots: this.core.slots(slot.machine),
        workerToken: this.core.workerToken(host.id, slot),
        expiresAt: allocation.deadlineAt,
      };
      return JSON.stringify(bootstrap);
    });
  }

  /** Running once a worker has enrolled, which acknowledges the launch; finished once invalid. */
  async observe(allocation: FleetAllocation): Promise<'starting' | 'running' | 'finished'> {
    return this.core.read(async (tx) => {
      const owned = await this.owning(allocation, tx);
      if (!owned || !(await this.valid(allocation, tx))) return 'finished';
      return owned.role === 'draining' || owned.slot.workerId ? 'running' : 'starting';
    });
  }

  async interrupt(
    tx: Transaction,
    command: PiCommandRecord,
    reason: PiInterruption,
  ): Promise<void> {
    if (!active.has(command.status)) return;
    this.core.forget(command);
    const conversation = await this.core.conversation(tx, command.conversationId);
    // Words the person saw stream stay as the answer, unless the turn's own result is in.
    const streamed = this.core.live.get(conversation.id)?.streamed;
    if (streamed?.commandId === command.id && streamed.text && !command.resultHash)
      command.messages.push({ role: 'assistant', text: streamed.text });
    command.status = 'interrupted';
    command.error = reason;
    command.completedAt = this.core.time();
    if (conversation.activeCommandId === command.id) conversation.activeCommandId = null;
    await this.core.saveCommand(tx, command);
    await this.core.saveConversation(tx, conversation);
    this.core.unsent.add(conversation.id);
  }
  /** The host ends with any turn still on it, every slot is released, and a move it was starting
   * is recorded as cancelled. A host keeping a turn (`keep`) stays, with no machine, for settle. */
  async end(
    tx: Transaction,
    host: PiHostRecord,
    reason: string,
    turnsEnd: PiInterruption = 'cancelled',
    keep?: (turn: PiCommandRecord) => boolean,
  ): Promise<void> {
    let kept = false;
    for (const turn of await this.core.turns(tx, host.id))
      if (keep?.(turn)) {
        await this.core.saveCommand(tx, turn);
        kept = true;
      } else await this.interrupt(tx, turn, turnsEnd);
    if (host.next) await this.abandon(tx, host, 'cancelled');
    for (const role of roles) {
      const slot = host[role];
      if (slot && (await this.allocation(slot.allocationId, tx)))
        await this.core.fleet.cancelOwned(this, slot.allocationId, tx);
      if (kept) host[role] = null;
    }
    if (!kept) {
      host.status = 'ended';
      host.ended = { at: this.core.time(), reason };
    }
    await this.saveHost(tx, host);
  }

  tick(): Promise<void> {
    if (this.core.closed || !this.core.config.enabled) return Promise.resolve();
    return (this.pending ??= this.reconcile().finally(() => {
      this.pending = undefined;
    }));
  }

  private async reconcile(): Promise<void> {
    const renter = await this.hostCaller().catch(() => undefined);
    // Most passes find nothing to do: one read looks at every live host, and only a host with
    // something due takes the writer lock. One host's failure leaves the others' passes alone;
    // the next pass retries it.
    const due = await this.core
      .read(async (tx) => {
        const ids: string[] = [];
        for (const row of await tx.all<{ data_json: string }>(
          "SELECT data_json FROM pi_hosts WHERE status='live'",
        )) {
          const host = decode<PiHostRecord>(row);
          if (await this.settle(tx, host, renter, true).catch(() => false)) ids.push(host.id);
        }
        return ids;
      })
      .catch(() => []);
    for (const id of due) {
      try {
        await this.core.state.transaction(async (tx) => {
          const host = await this.core.host(tx, id);
          if (host?.status === 'live') await this.settle(tx, host, renter);
        });
        this.core.streams.wake(id);
        this.core.announce();
      } catch {
        /* retried on the next pass */
      }
    }
    // Fleet's progress is what open pages are waiting on: one read sees every live conversation.
    await this.core
      .read(async (tx) => {
        for (const id of [...this.core.live.keys()]) {
          const seen = await (async () => {
            const conversation = await this.core.conversation(tx, id);
            const command = conversation.activeCommandId
              ? await this.core.command(tx, id, conversation.activeCommandId)
              : null;
            return { conversation, command, ...(await this.machineOf(tx, conversation)) };
          })().catch(() => null);
          if (seen) this.core.stage(seen.conversation, seen.command, seen.host, seen.allocation);
        }
      })
      .catch(() => {});
  }
  /** Applies Fleet's facts to a host: N not ready (T6), C lost (T7), D released once drained
   * (T5), turns expired or out of the queue, the idle end (T8) and a deadline's rollover (T10).
   * With `dry`, in a read, only whether any of that is due. */
  async settle(
    tx: Transaction,
    host: PiHostRecord,
    renter?: Caller,
    dry = false,
  ): Promise<boolean> {
    const now = this.core.time();
    if (this.core.idleOver(host)) {
      if (dry) return true;
      const person = await this.core.person(tx, host.key);
      person.sticky = null;
      await this.core.savePerson(tx, person);
      await this.end(tx, host, 'idle');
      return true;
    }
    const facts = new Map<string, FleetAllocation | null>();
    for (const role of roles) {
      const slot = host[role];
      if (slot) facts.set(slot.allocationId, await this.allocation(slot.allocationId, tx));
    }
    const fact = (slot: PiSlot | null) => (slot && facts.get(slot.allocationId)) || null;
    let turns = await this.core.turns(tx, host.id);
    let changed = false;
    const { next } = host;
    if (next && (gone(fact(next), now) || next.readyBy <= now)) {
      if (dry) return true;
      await this.abandon(
        tx,
        host,
        'failed',
        fact(next)?.error === 'person_capped'
          ? 'spending limit'
          : fact(next)?.error === 'runtime_refused'
            ? 'no free machine'
            : next.readyBy <= now || fact(next)?.error === 'runtime_not_ready'
              ? 'not ready in time'
              : 'the machine stopped',
      );
      changed = true;
    }
    if (host.current && gone(fact(host.current), now)) {
      if (dry) return true;
      // During a move C's unclaimed turns follow N, as at a cut-over.
      await this.lose(tx, turns, host.current, fact(host.current), !host.next);
      if (host.next) await this.promote(tx, host, true, fact(host.next)?.phase === 'queued');
      else host.current = null;
      changed = true;
    }
    if (host.draining && gone(fact(host.draining), now)) {
      if (dry) return true;
      await this.lose(tx, turns, host.draining, fact(host.draining));
      host.draining = null;
      changed = true;
    }
    // Slot deadlines follow Fleet's, which restarts one as it leaves the queue.
    for (const role of roles) {
      const slot = host[role];
      const allocation = fact(slot);
      if (slot && allocation && slot.expiresAt !== allocation.deadlineAt) {
        if (dry) return true;
        slot.expiresAt = allocation.deadlineAt;
        changed = true;
      }
    }
    if (changed) turns = await this.core.turns(tx, host.id);
    for (const turn of turns) {
      const role = roleOf(host, turn.runtimeId);
      if (turn.expiresAt <= now || this.stalled(turn)) {
        if (dry) return true;
        await this.interrupt(tx, turn, 'turn_expired');
        changed = true;
      } else if (turn.status === 'waiting' && role && fact(host[role])?.phase !== 'queued') {
        // Out of the queue: cold start gets a turn's time, within the deadline Fleet now keeps.
        if (dry) return true;
        await this.reassign(tx, turn, host[role]!, false);
        changed = true;
      }
    }
    // A turn no slot serves starts again (again): on C, rented when the host has none.
    const unplaced = turns.filter(
      (turn) => active.has(turn.status) && !roleOf(host, turn.runtimeId),
    );
    if (unplaced.length) {
      if (dry) return true;
      const fresh = !host.current;
      let reason: PiInterruption = 'runtime_lost';
      if (fresh && renter) {
        const { source } = await this.core.conversation(tx, unplaced[0].conversationId);
        const machine = await this.core.starting(await this.core.person(tx, host.key), source, tx);
        // Fleet refusing the rental, its daily cap among them, is no lost machine.
        host.current = await this.rent(renter, host, machine, tx).catch((error: unknown) => {
          reason =
            error instanceof MervError && error.code === 'fleet_compute_cap'
              ? 'wallet_refused'
              : 'runtime_refused';
          return null;
        });
      }
      const queued = fresh || fact(host.current)?.phase === 'queued';
      for (const turn of unplaced)
        if (host.current) await this.reassign(tx, turn, host.current, queued);
        else await this.interrupt(tx, turn, reason);
      changed = true;
    }
    const { current } = host;
    const newest = turns.at(-1);
    if (current?.workerId && newest && !host.next && !host.draining && renter) {
      // Only a machine in use is renewed near its deadline: of its kind while the newest turn's
      // person may still choose it, else the default. One they may no longer choose (take holds
      // their turns) is left for the default at once, unannounced like a rollover.
      const { source } = await this.core.conversation(tx, newest.conversationId);
      const allowed = (await this.core.machineChoice(source, current.machine, tx)).allowed;
      if (
        (!allowed || Date.parse(current.expiresAt) - this.core.clock() < rolloverMs) &&
        !(await this.core.person(tx, host.key)).moves.some(
          (move) =>
            move.by === 'deadline' &&
            move.outcome === 'failed' &&
            Date.parse(move.at) + rolloverRetryMs > this.core.clock(),
        ) &&
        (await this.core.fleet.free(this.core.hostProject, tx)) >= moveRoom
      ) {
        if (dry) return true;
        const to = allowed ? current.machine : this.core.config.machines[0].key;
        const moved = await this.move(tx, renter, host, to, 'deadline');
        changed ||= moved;
      }
    }
    if (!host.current && !host.next && !host.draining) {
      if (dry) return true;
      await this.end(tx, host, 'lost');
      return true;
    }
    if (!changed || dry) return false;
    if (!(await this.core.turns(tx, host.id)).length) host.idleSince ??= now;
    await this.saveHost(tx, host);
    return true;
  }
  /** The turns on a slot Fleet no longer runs, its unclaimed ones only with `unclaimed`. One whose
   * machine was lost starts again if it may (again); every other ends, as a refused or stopped
   * machine's do. */
  private async lose(
    tx: Transaction,
    turns: PiCommandRecord[],
    slot: PiSlot,
    allocation: FleetAllocation | null,
    unclaimed = true,
  ) {
    const reason = lost(allocation);
    for (const turn of turns)
      if (turn.runtimeId !== slot.allocationId || !(unclaimed || turn.workerId)) continue;
      else if (reason === 'runtime_lost' && this.again(turn, true))
        await this.core.saveCommand(tx, turn);
      else await this.interrupt(tx, turn, reason);
  }
  /** A turn that has shown nothing, no word and no tool call, starts again on a fresh machine:
   * once after its own machine is lost (`once`), and after every restart. Its claim is dropped,
   * so its old worker can do nothing more with it; settle places it, and the caller saves it. */
  again(turn: PiCommandRecord, once: boolean): boolean {
    const shown = turn.firstTextAt || turn.calledAt || turn.resultHash;
    if (shown || turn.expiresAt <= this.core.time() || (once && turn.retried)) return false;
    this.core.forget(turn);
    const live = this.core.live.get(turn.conversationId);
    if (live?.turn?.commandId === turn.id) delete live.turn;
    if (once) turn.retried = true;
    Object.assign(turn, { status: 'waiting', workerId: null });
    for (const claimed of ['startedAt', 'tools', 'canMove'] as const) delete turn[claimed];
    return true;
  }
  /** N becomes C: at cut-over once proven ready (T4), or first when C is lost (T7, its claimed
   * turns already lost). C's unclaimed turns follow N; at cut-over its claimed turns finish on D
   * while C drains, or C stops at once. */
  async promote(
    tx: Transaction,
    host: PiHostRecord,
    lostSlot = false,
    queued = false,
  ): Promise<void> {
    const old = host.current!;
    const { by, conversationId, readyBy: _, ...slot } = host.next!;
    host.current = lostSlot ? slot : { ...slot, readyAt: this.core.time() };
    host.next = null;
    const turns = (await this.core.turns(tx, host.id)).filter(
      ({ runtimeId }) => runtimeId === old.allocationId,
    );
    for (const turn of turns)
      if (!turn.workerId) await this.reassign(tx, turn, host.current, queued);
    if (!lostSlot) {
      if (turns.some(({ workerId }) => workerId)) host.draining = old;
      else await this.core.fleet.cancelOwned(this, old.allocationId, tx);
    }
    await this.record(tx, host.key, {
      by,
      from: old.machine,
      to: slot.machine,
      outcome: 'moved',
      ...(conversationId && { conversationId }),
    });
  }
  /** N's move ends without a cut-over: its machine is released, and the move is recorded, as the
   * agent's rules count every move whatever its outcome. */
  async abandon(
    tx: Transaction,
    host: PiHostRecord,
    outcome: 'failed' | 'cancelled',
    reason?: PiMoveFailure,
  ): Promise<void> {
    const next = host.next!;
    if (await this.allocation(next.allocationId, tx))
      await this.core.fleet.cancelOwned(this, next.allocationId, tx);
    await this.record(tx, host.key, {
      by: next.by,
      from: host.current?.machine ?? next.machine,
      to: next.machine,
      outcome,
      ...(reason && { reason }),
      ...(next.conversationId && { conversationId: next.conversationId }),
    });
    host.next = null;
  }
  /** An unclaimed turn moves to another slot: a new model credential, and a turn's time there. */
  private async reassign(
    tx: Transaction,
    turn: PiCommandRecord,
    slot: PiSlot,
    queued: boolean,
  ): Promise<void> {
    const { source } = await this.core.conversation(tx, turn.conversationId);
    turn.runtimeId = slot.allocationId;
    turn.epoch = slot.epoch;
    turn.machine = slot.machine;
    turn.status = queued ? 'waiting' : 'starting';
    turn.expiresAt = new Date(this.turnEnd(slot, source, this.startMs(queued))).toISOString();
    await this.core.saveCommand(tx, turn);
    this.core.unsent.add(turn.conversationId);
  }
  /** T2: starts `to` as the next slot while C keeps serving. False, recorded as a failed move,
   * when Fleet has no room for a second machine. */
  async move(
    tx: Transaction,
    renter: Caller,
    host: PiHostRecord,
    to: string,
    by: PiMoveBy,
    conversationId?: string,
  ): Promise<boolean> {
    check(
      host.current && !host.next && !host.draining,
      'pi_move_in_progress',
      'A move is already under way; try again shortly',
      409,
    );
    const from = host.current.machine;
    // Fleet refusing the rental, its daily cap among them, fails the move; C keeps serving.
    const slot =
      (await this.core.fleet.free(this.core.hostProject, tx)) >= moveRoom &&
      (await this.rent(renter, host, to, tx).catch((error: unknown) => {
        if (error instanceof MervError && error.status < 500) return error;
        throw error;
      }));
    if (!slot || slot instanceof MervError) {
      await this.record(tx, host.key, {
        by,
        from,
        to,
        outcome: 'failed',
        reason: slot && slot.code === 'fleet_compute_cap' ? 'spending limit' : 'no free machine',
        ...(conversationId && { conversationId }),
      });
      return false;
    }
    host.next = {
      ...slot,
      by,
      conversationId: conversationId ?? null,
      readyBy: new Date(this.core.clock() + readyMs).toISOString(),
    };
    return true;
  }
}
