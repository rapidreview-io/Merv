// Shared by the build tools, app, website and installer manifest.
export const fileName = /^Merv-(.+?)(?:-stamped)?-(arm64|x64)\.(zip|dmg)$/;
export const parts = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]{1,40}))?$/.exec(version);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]?.split('.'),
  };
};
/** Semver order: -1, 0 or 1. A version with a suffix comes before the same one without; what cannot be read is equal. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const [n, m] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (n && m) return Number(p) < Number(q) ? -1 : 1;
    if (n !== m) return n ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Legacy mixed feeds did not label their older files. Never lend them the tip's Apple approval. */
export function fileBuild(found, file) {
  const version = file.version ?? fileName.exec(file.name)?.[1];
  const same = version === found.version;
  return {
    version,
    commit: file.commit ?? (same ? found.commit : undefined),
    notarized: found.channel !== 'nightly' && (file.notarized ?? (same && found.notarized)),
    minimumSystem: file.minimumSystem ?? found.minimumSystem,
  };
}

export const appleStatus = (notarized) =>
  notarized ? 'Checked by Apple' : 'Not notarized by Apple';

/** latest.txt: release.json for a shell with no JSON reader. One `key value` line, then one line a file. */
export function releaseText(release) {
  return [
    `version ${release.version}`,
    `notarized ${release.notarized ? 'yes' : 'no'}`,
    ...(release.minimumSystem ? [`minimum ${release.minimumSystem}`] : []),
    ...release.files.map((file) => {
      const build = fileBuild(release, file);
      return `file ${file.arch} ${file.kind} ${file.name} ${file.sha256} ${build.version ?? 'unknown'} ${build.notarized ? 'yes' : 'no'} ${build.minimumSystem ?? '-'}`;
    }),
    '',
  ].join('\n');
}
