/** Rename and whitespace handling are stated, so an upgrade of Git changes nothing silently. */
export const MERGE_SETTINGS = [
  'merge.renormalize=false',
  'merge.renames=true',
  'merge.directoryRenames=false',
  'diff.renameLimit=1000',
  'merge.renameLimit=1000',
  'merge.conflictStyle=merge',
].flatMap((setting) => ['-c', setting]);
