/** Rename and whitespace handling are stated, so an upgrade of Git changes nothing silently. */
export const MERGE_SETTINGS = [
  '-c',
  'merge.renormalize=false',
  '-c',
  'merge.renames=true',
  '-c',
  'merge.directoryRenames=false',
  '-c',
  'diff.renameLimit=1000',
  '-c',
  'merge.renameLimit=1000',
  '-c',
  'merge.conflictStyle=merge',
];
