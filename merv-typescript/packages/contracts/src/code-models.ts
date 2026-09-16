/** Portable immutable code observation identities, without server runtime dependencies. */
export type CodeCaptureRef =
  { kind: 'session-final'; sessionId: string } | { kind: 'code-commit'; commandId: string };
