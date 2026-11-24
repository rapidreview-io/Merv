import type { Release, ReleaseFile } from './release.js';
export const fileName: RegExp;
export function parts(version: string): { core: number[]; pre?: string[] } | undefined;
export function compareVersions(a: string, b: string): number;
export function fileBuild(
  found: Pick<Release, 'version' | 'commit' | 'notarized' | 'channel' | 'minimumSystem'>,
  file: Pick<ReleaseFile, 'name' | 'version' | 'commit' | 'notarized' | 'minimumSystem'>,
): {
  version: string | undefined;
  commit: string | undefined;
  notarized: boolean;
  minimumSystem: string;
};
export function appleStatus(notarized: boolean): string;
export function releaseText(
  release: Pick<
    Release,
    'channel' | 'version' | 'commit' | 'notarized' | 'minimumSystem' | 'files'
  >,
): string;
