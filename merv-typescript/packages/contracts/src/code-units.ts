/** Technical ownership of a repository writer generation. */
/**
 * Who may advance a unit's branch in Code's repository. A generation belongs to one leased
 * session; the next begins only once this one closed or an operator fenced it.
 */
export type CodeWriterState =
  'idle' | 'reserved' | 'active' | 'closing' | 'closed' | 'recovery_required';
export interface CodeWriterStatus {
  generation: number;
  state: CodeWriterState;
  /** Why no new writer may be leased now, in the words of a refusal; null when one may. */
  blocked: { code: string; message: string } | null;
}
