import type {} from 'cordis';

interface ProfileBase {
  name: string;
  executable: string;
  enabled: boolean;
  parallelism: number;
}
/** Trusted machine configuration. Remote settings can only tune documented fields. */
export type RunnerProfile = ProfileBase &
  (
    | { harness: 'codex'; model?: string; effort?: string }
    | {
        harness: 'claude';
        model?: string;
        effort?: string;
        servers?: { name: string; url: string; bearerEnv: string }[];
      }
    | { harness: 'command'; args?: string[] }
  );

/** Local machine configuration. Remote settings can tune profiles, never replace executables. */
export interface RunnerConfig {
  directory: string;
  baseUrl: string;
  projectId: string;
  credentialEnv: string;
  profiles: RunnerProfile[];
  /** A local source repository; the runner creates and owns its private Git copy. */
  workspace?: { repository: string; baseRef: string } | { github: true };
  /** CLI composition: omit for the existing Code driver, or [] for workspace-free research. */
  workspaceDrivers?: 'code'[];
  capacity?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}
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
