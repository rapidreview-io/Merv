import { nativeWorkGuidance } from '@merv/sandboxes/native-guidance';
import assert from 'node:assert/strict';
import type { NativeSandboxWork } from '@merv/sandboxes/types';

/** A trusted owner binding spy: evidence is granted only by its explicit verified ID set. */
export function nativeWorkFixture() {
  let connected = true;
  const revoked: string[] = [];
  const pins = new Set<string>();
  const verified = new Map<string, string[]>();
  const changes: { workId: string; attempt?: string; closed?: boolean }[] = [];
  const key = (project: string, kind: string, id: string) => `${project}:${kind}:${id}`;
  const service: NativeSandboxWork = {
    guidance: nativeWorkGuidance,
    revokeAssignment: async (leaseId) => {
      revoked.push(leaseId);
    },
    connected: async () => connected,
    pin: async (project, kind, id) => {
      pins.add(key(project, kind, id));
    },
    references: async (project, kind, id, attempt, profile) => {
      assert.ok(pins.has(key(project, kind, id)), 'native scope must be pinned before assignment');
      return {
        sandboxConnectionId: 'connection_fixture',
        sandboxWorkId: id,
        sandboxWorkKind: kind,
        sandboxAttempt: attempt,
        sandboxProfile: profile,
      };
    },
    artifactIds: async (project, kind, id) =>
      pins.has(key(project, kind, id)) ? (verified.get(id) ?? []) : [],
    transition: async (project, kind, id, change) => {
      assert.ok(pins.has(key(project, kind, id)));
      changes.push({ workId: id, ...change });
    },
  };
  return {
    service,
    revoked,
    verified,
    changes,
    pins,
    connected: (value: boolean) => {
      connected = value;
    },
  };
}
