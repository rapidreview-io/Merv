import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLedger, terminalLaunch, type LaunchRecord } from './ledger.js';

export interface ProcessCommand {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
}
export interface ProcessLaunch {
  launchId: string;
  command: ProcessCommand;
  sessionToken: string;
  deadline: number;
}
/**
 * Where a launched process, or the wrapper a profile runs it under, may leave what the run
 * cost. The convention is vendor-neutral: Merv parses no harness output, and whoever can
 * write the file is trusted no further than a self-report.
 */
export const usageFileVariable = 'MERV_USAGE_FILE';
export const usageFile = (record: LaunchRecord) => join(record.runDirectory, 'usage.json');
const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Controls only authenticated supervisors. A saved PID is never evidence or a kill target. */
export class ProcessHost {
  constructor(private readonly ledger: LocalLedger) {}

  async launch(input: ProcessLaunch): Promise<LaunchRecord> {
    input = { ...input };
    const record = this.required(input.launchId);
    if (terminalLaunch(record)) return record;
    if (record.status === 'uncertain') throw new Error('An uncertain launch cannot be restarted');
    if (!/^ms_[A-Za-z0-9_-]{43}$/.test(input.sessionToken))
      throw new Error('A scoped session token is required');
    if (!Number.isSafeInteger(input.deadline) || input.deadline !== record.deadline)
      throw new Error('Launch deadline differs from its durable reservation');
    // Profile objects deliberately redact toJSON for diagnostics. IPC is the one intended
    // in-memory secret transport, so project fields without those serialization hooks.
    const command: ProcessCommand = {
      executable: input.command.executable,
      args: [...input.command.args],
      cwd: input.command.cwd,
      env: {
        ...Object.fromEntries(Object.entries(input.command.env ?? {})),
        [usageFileVariable]: usageFile(record),
      },
      ...(input.command.stdin === undefined ? {} : { stdin: input.command.stdin }),
    };
    this.validateCommand(command, input.sessionToken);
    if (record.status === 'reserved') {
      // Only what this launch writes may be reported as its usage.
      rmSync(usageFile(record), { force: true });
      // Multiple controllers/retries may reach spawn, but only one guardian can claim the SQL row.
      const guardian = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./supervisor.mjs', import.meta.url)),
          'guardian',
          this.ledger.path,
          input.launchId,
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        },
      );
      guardian.on('error', () => {});
      guardian.unref();
    }
    const until = Date.now() + 6000;
    while (true) {
      try {
        await this.request(input.launchId, {
          action: 'launch',
          command,
          sessionToken: input.sessionToken,
        });
        return this.required(input.launchId);
      } catch (error) {
        const now = this.required(input.launchId);
        if (terminalLaunch(now)) return now;
        if (!this.unreachable(error) || Date.now() >= until) {
          if (this.unreachable(error)) this.ledger.markUncertain(input.launchId);
          throw error;
        }
        await pause(25);
      }
    }
  }

  async inspect(id: string): Promise<LaunchRecord> {
    const record = this.required(id);
    if (terminalLaunch(record) || record.status === 'reserved') return record;
    try {
      await this.request(id, { action: 'inspect' });
    } catch (error) {
      if (!this.unreachable(error)) throw error;
      this.ledger.markUncertain(id);
    }
    return this.required(id);
  }
  async extendDeadline(id: string, deadline: number): Promise<LaunchRecord> {
    const record = this.required(id);
    if (terminalLaunch(record)) return record;
    await this.request(id, { action: 'deadline', deadline });
    return this.required(id);
  }
  async stop(id: string): Promise<LaunchRecord> {
    let record = this.required(id);
    if (terminalLaunch(record)) return record;
    if (record.status === 'reserved') {
      // The same SQL predicate arbitrates cancellation versus the guardian's irreversible claim.
      if (this.ledger.cancelReservation(id)) return this.required(id);
    }
    try {
      await this.request(id, { action: 'stop' });
    } catch (error) {
      if (!this.unreachable(error)) throw error;
      this.ledger.markUncertain(id);
      return this.required(id);
    }
    const until = Date.now() + 5000;
    while (!terminalLaunch((record = this.required(id))) && Date.now() < until) {
      if (record.status === 'uncertain') return record;
      await pause(20);
    }
    if (!terminalLaunch(record)) this.ledger.markUncertain(id, 'stop_unconfirmed');
    return this.required(id);
  }
  async reconcile(): Promise<void> {
    for (const record of this.ledger.list()) await this.inspect(record.id);
  }

  private required(id: string): LaunchRecord {
    const record = this.ledger.get(id);
    if (!record) throw new Error('Launch intent must be reserved before using its process host');
    return record;
  }
  private validateCommand(command: ProcessCommand, token: string): void {
    if (
      !command.executable ||
      !Array.isArray(command.args) ||
      !command.cwd ||
      [command.executable, command.cwd, ...command.args].some(
        (value) => typeof value !== 'string' || value.includes('\0') || value.includes(token),
      ) ||
      (command.stdin !== undefined && typeof command.stdin !== 'string')
    )
      throw new Error('Invalid process command');
    for (const [key, value] of Object.entries(command.env ?? {})) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        typeof value !== 'string' ||
        value.includes('\0') ||
        /^MERV_.*(?:API_KEY|SOURCE|BEARER|RUNNER_KEY|AUTH_TOKEN)$/i.test(key) ||
        /mk_[A-Za-z0-9_-]{32,}/.test(value) ||
        (value.includes(token) && key !== 'MERV_AGENT_SESSION_TOKEN')
      ) {
        throw new Error('Process environment must not contain source credentials');
      }
    }
    if (Buffer.byteLength(JSON.stringify(command)) > 800000)
      throw new Error('Process command is too large');
  }
  private unreachable(error: unknown): boolean {
    return ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    );
  }
  private request(id: string, message: Record<string, unknown>): Promise<void> {
    const socketDirectory = `/tmp/merv-runner-${process.getuid!()}-${createHash('sha256').update(this.ledger.directory).digest('hex').slice(0, 16)}`;
    const path = join(
      socketDirectory,
      `${createHash('sha256').update(id).digest('hex').slice(0, 24)}.sock`,
    );
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let settled = false,
        body = '';
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        error ? reject(error) : resolve();
      };
      socket.setTimeout(2000, () =>
        finish(Object.assign(new Error('Supervisor did not respond'), { code: 'ETIMEDOUT' })),
      );
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ ...message, auth: this.ledger.ipcToken(id) })}\n`),
      );
      socket.on('error', finish);
      socket.on('data', (data) => {
        body += data.toString('utf8');
        if (body.length > 65536) {
          finish(new Error('Invalid supervisor response'));
          return;
        }
        const end = body.indexOf('\n');
        if (end < 0) return;
        try {
          const value = JSON.parse(body.slice(0, end));
          finish(
            value.ok === true ? undefined : new Error(`Supervisor refused: ${String(value.error)}`),
          );
        } catch {
          finish(new Error('Invalid supervisor response'));
        }
      });
      socket.on('end', () => {
        if (!settled)
          finish(Object.assign(new Error('Supervisor disconnected'), { code: 'ECONNRESET' }));
      });
    });
  }
}
