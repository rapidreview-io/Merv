import type {} from 'cordis';

export type { RunnerProfile } from './profiles.js';
export interface RunnerSnapshot {
  runnerId: string;
  state:
    | 'starting'
    | 'idle'
    | 'running'
    | 'offline'
    | 'unauthorized'
    | 'degraded'
    | 'stopping'
    | 'stopped';
  lastError?: string;
  /**
   * Why the server last declined to hand this runner work. A runner with a queue behind it
   * and project dispatch switched off is indistinguishable from one with nothing to do, and
   * that silence has cost more than one person an hour of looking at a healthy idle runner.
   */
  lastDeclined?: string;
  pendingRequests: number;
  launches: {
    id: string;
    sessionId: string;
    agentId?: string;
    agentSessionId?: string;
    status: string;
    platform: string;
    deadline: number;
    exitCode?: number | null;
    releasePending: boolean;
    workspace?: { status: string; headOid?: string; capturePending: boolean };
  }[];
}
export interface Runner {
  start(): Promise<void>;
  tick(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): RunnerSnapshot;
}
declare module 'cordis' {
  interface Context {
    runner: Runner;
  }
}
