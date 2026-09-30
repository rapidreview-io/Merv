/** Portable compute file contracts; no server runtime or credentials. */
export interface ComputeOutputs {
  files: { name: string; path: string }[];
  maxBytes: number;
}
export interface SandboxComputeOutput {
  name: string;
  objectId: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string | null;
}
