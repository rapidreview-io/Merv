import { RunnerControlError } from './client.js';

// Only fixed codes cross the supervisor boundary. Error messages and paths can contain
// assignment data or credentials; retain neither when a local preparation fails.
const localCodes: Readonly<Record<string, string>> = {
  ENOSPC: 'runner_filesystem_no_space',
  EDQUOT: 'runner_filesystem_quota',
  EACCES: 'runner_filesystem_access_denied',
  EPERM: 'runner_filesystem_operation_denied',
  ENOENT: 'runner_filesystem_missing',
  ENOTDIR: 'runner_filesystem_not_directory',
  EISDIR: 'runner_filesystem_is_directory',
  EEXIST: 'runner_filesystem_exists',
  ENOTEMPTY: 'runner_filesystem_not_empty',
  ELOOP: 'runner_filesystem_symlink_loop',
  EXDEV: 'runner_filesystem_cross_device',
  EMFILE: 'runner_filesystem_open_file_limit',
  ENFILE: 'runner_filesystem_system_file_limit',
  ERR_FS_CP_DIR_TO_NON_DIR: 'runner_copy_directory_to_file',
  ERR_FS_CP_NON_DIR_TO_DIR: 'runner_copy_file_to_directory',
  ERR_FS_CP_EINVAL: 'runner_copy_invalid_path',
  ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: 'runner_copy_symlink_to_subdirectory',
  ERR_FS_CP_FIFO_PIPE: 'runner_copy_fifo',
  ERR_FS_CP_SOCKET: 'runner_copy_socket',
  ERR_FS_CP_UNKNOWN: 'runner_copy_unknown_file_type',
};

export const diagnostic = (error: unknown): string => {
  if (error instanceof RunnerControlError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return 'runner_operation_failed';
  if (Object.hasOwn(localCodes, code)) return localCodes[code]!;
  return /^[a-z_]{1,100}$/.test(code) ? code : 'runner_operation_failed';
};
