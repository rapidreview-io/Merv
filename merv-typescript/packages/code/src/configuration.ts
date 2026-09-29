import { MervError } from '@merv/contracts';

/** Refuse retired protection explicitly, before any credentials or storage are opened. */
export function rejectRetiredBackup(value: unknown): unknown {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'backup'))
    throw new MervError(
      'code_backup_retired',
      'Application repository backups were retired. Migrate to deploy/recovery-snapshot.py and verify a complete recovery snapshot before removing repositories.backup. Use the preserved legacy recovery kit for existing backups.',
    );
  return value;
}
