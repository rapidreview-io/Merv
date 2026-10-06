import { chmodSync, lstatSync, mkdirSync } from 'node:fs';

/**
 * A directory only this machine's user may enter, which the runner's ledger and every workspace
 * driver's storage inside it are kept in: made 0700 when missing, and refused with `refuse()`
 * when it is a link, not a directory, or someone else's. Both sides of the driver contract need
 * it and neither may import the other, so it lives with that contract.
 */
export function privateDirectory(
  path: string,
  refuse: () => Error = () => new Error('Unsafe runner directory'),
): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw refuse();
  chmodSync(path, 0o700);
  return path;
}
