/**
 * A release of Merv.app as runmerv.com serves it and the app reads it: release.json, one a channel.
 * The release script (desktop/scripts/release.mjs) writes it; the website's download page, the
 * installer script and the app's own update check all read the same file.
 */
import { z } from 'zod';
import { parts, compareVersions } from './release-info.mjs';
export { compareVersions, fileBuild, appleStatus, releaseText } from './release-info.mjs';

export const CHANNELS = ['stable', 'nightly'] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (value: unknown): value is Channel =>
  value === 'stable' || value === 'nightly';

const releaseFile = z.object({
  arch: z.enum(['arm64', 'x64']),
  kind: z.enum(['dmg', 'zip']),
  name: z.string().regex(/^[\w.-]{1,120}$/),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Older chips can keep an earlier build. These describe these bytes, not the channel tip. */
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/)
    .optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  notarized: z.boolean().optional(),
  minimumSystem: z.string().max(20).optional(),
});
export const release = z.object({
  channel: z.enum(CHANNELS),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/),
  date: z.string().datetime(),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  /** Signed with a Developer ID and notarized by Apple: it opens with a double click. */
  notarized: z.boolean(),
  minimumSystem: z.string().max(20),
  files: z.array(releaseFile).max(16),
  /** What is new, a line each, written for the people who use it. */
  notes: z.array(z.string().max(300)).max(40),
  /** The oldest version the site still works with: a build before it has to update, and is told so. */
  oldest: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
});
export type Release = z.infer<typeof release>;
export type ReleaseFile = z.infer<typeof releaseFile>;

/** The channel a build follows unless the person chose another: a nightly's version says so. */
export const channelOf = (version: string): Channel =>
  /-nightly\b/.test(version) ? 'nightly' : 'stable';

/**
 * Whether a channel's release is one to move to from the build that is running. Newer always is.
 * So is anything else on a channel the person switched to: leaving nightly for stable goes back a
 * version, and that is what they asked for.
 */
export const offers = (running: string, following: Channel, next: Pick<Release, 'version'>) =>
  next.version !== running &&
  (compareVersions(next.version, running) > 0 || channelOf(running) !== following);

/**
 * Whether the build that is running is older than the oldest one the site still works with. Only the
 * three numbers count: a nightly cut toward 0.1.2 is not behind 0.1.2.
 */
export const outgrown = (running: string, found: Pick<Release, 'oldest'>) => {
  const [mine, least] = [parts(running), found.oldest ? parts(found.oldest) : undefined];
  if (!mine || !least) return false;
  for (let i = 0; i < 3; i++)
    if (mine.core[i] !== least.core[i]) return mine.core[i]! < least.core[i]!;
  return false;
};

export const fileFor = (
  found: Pick<Release, 'files'>,
  arch: ReleaseFile['arch'],
  kind: ReleaseFile['kind'],
) => found.files.find((file) => file.arch === arch && file.kind === kind);

/**
 * What a build knows about itself, as the release script stamped it: when it was built and whether
 * on this Mac (`--local`) rather than published. The commit is kept apart: it is never shown, only copied.
 */
export interface Build {
  version: string;
  channel: Channel;
  builtAt?: string;
  local?: boolean;
}
interface BuildDetails extends Build {
  commit?: string;
  dirty?: boolean;
  following?: Channel;
}
/** Whose clock and words: the person's own unless a test names them. */
export interface Reader {
  locale?: string;
  timeZone?: string;
}

const moment = (iso: string | undefined, reader: Reader, options: Intl.DateTimeFormatOptions) => {
  const at = iso ? new Date(iso) : undefined;
  return at && !Number.isNaN(at.getTime())
    ? new Intl.DateTimeFormat(reader.locale, { ...options, timeZone: reader.timeZone }).format(at)
    : undefined;
};

/**
 * The build in words a person reads, with no commit in it: "Merv 0.1.29" for a published stable,
 * "Merv Nightly · built 17 Nov, 13:37" for a nightly, and "· built on this Mac, 17 Nov, 14:50"
 * after either for a local build. The date is in the reader's own locale and time zone.
 */
export function buildLine(build: Build, reader: Reader = {}): string {
  const name = build.channel === 'nightly' ? 'Merv Nightly' : `Merv ${build.version}`;
  const when = moment(build.builtAt, reader, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  if (build.local) return `${name} · built on this Mac${when ? `, ${when}` : ''}`;
  return build.channel === 'nightly' && when ? `${name} · built ${when}` : name;
}

/** What pressing the build line copies: everything needed to name the build exactly, the commit included. */
export function buildDetails(build: BuildDetails, reader: Reader = {}): string {
  const when = moment(build.builtAt, reader, { dateStyle: 'medium', timeStyle: 'short' });
  return [
    `Merv ${build.version}`,
    `Channel: ${build.channel}${build.following && build.following !== build.channel ? ` (following ${build.following})` : ''}`,
    `Built: ${when ? `${when} (${new Date(build.builtAt!).toISOString()})` : 'unknown'}`,
    `Build: ${build.local ? 'built on this Mac' : build.local === false ? 'published' : 'unknown'}`,
    `Commit: ${build.commit ? `${build.commit}${build.dirty ? ', with uncommitted changes' : ''}` : 'unknown'}`,
  ].join('\n');
}
