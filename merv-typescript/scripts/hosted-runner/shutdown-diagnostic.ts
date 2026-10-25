// Only fixed supervisor/workspace codes may enter status.json. Git stderr and error
// messages can contain remote URLs, credentials or working-copy contents.
const codes = new Set([
  'assignment_cleanup_failed',
  'workspace_git_timeout',
  'workspace_git_failed',
  'workspace_process_stop_unconfirmed',
  'workspace_shutdown_head_conflict',
  'workspace_shutdown_not_durable',
  'workspace_invalid_git_access',
  'workspace_file_too_large',
  'workspace_foreign_path',
  'workspace_foreign_checkout',
]);

export function shutdownDiagnostic(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && codes.has(code) ? code : 'shutdown_operation_failed';
}
