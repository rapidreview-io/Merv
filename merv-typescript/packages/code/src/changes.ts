import { check, type State, type Transaction } from '@merv/contracts';

export type CodeChange =
  { kind: 'binding'; projectId: string } | { kind: 'writer'; projectId: string; unitId: string };
type Observer = (change: CodeChange, tx: Transaction) => Promise<void>;

/** Optional projections participate in the storage mutation's transaction, never after commit. */
export class CodeChanges {
  private readonly observers = new Set<{ observer: Observer }>();
  private revision = 0;
  constructor(private readonly state: State) {}

  observe(observer: Observer): () => void {
    const entry = { observer };
    this.observers.add(entry);
    this.revision++;
    return () => {
      if (this.observers.delete(entry)) this.revision++;
    };
  }

  async emit(change: CodeChange, tx: Transaction): Promise<void> {
    this.state.assertTransaction(tx);
    const revision = this.revision;
    for (const { observer } of [...this.observers]) {
      await observer(change, tx);
      check(
        revision === this.revision,
        'code_projection_changed',
        'A Code projection changed while this mutation was being applied; retry it',
        409,
      );
    }
  }
}
