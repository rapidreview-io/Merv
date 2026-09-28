import { MervError, MAX_ARTIFACT_BYTES, type Artifact, type State } from '@merv/contracts';
import { META, fromRow } from './content.js';

const log = (record: object) => void process.stderr.write(`${JSON.stringify(record)}\n`);
/** What went wrong, without a message that might quote the row. */
const code = (error: unknown) =>
  error instanceof MervError ? error.code : error instanceof Error ? error.name : 'unknown';

/**
 * Temporary: moves the bytes of rows written before bytes were kept in the row into the row, so
 * reads of them stop reaching storage. Only a server whose config turns it on runs it. Rows are
 * read a page at a time; each row's bytes are fetched outside any transaction and written in a
 * short transaction of their own, which the CHECK verifies. Bytes that are gone or corrupt are
 * logged as lost and passed over; any other failure of a row is logged as failed and retried by
 * the next pass; an outage stops the pass until the next boot. Delete this, with its config key,
 * once prod has no such row left but those logged as lost.
 */
export class Backfill {
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  constructor(
    private state: State,
    /** The verified bytes of a row without content, from blobs. */
    private fetch: (artifact: Artifact) => Promise<Buffer>,
  ) {}
  /** Starts a pass, or has the running one go again once it ends. */
  kick() {
    if (this.stopped) return;
    this.again = true;
    this.running ??= (async () => {
      while (this.again && !this.stopped) {
        this.again = false;
        await this.pass();
      }
    })().finally(() => (this.running = undefined));
  }
  /** Stops after the row in hand. */
  async stop() {
    this.stopped = true;
    await this.running;
  }
  private async pass() {
    const counts = { filled: 0, skipped: 0, failed: 0 };
    try {
      for (let after = ''; ;) {
        const rows = await this.state.read((sql) =>
          sql.all(
            `SELECT ${META} FROM artifacts WHERE content IS NULL AND size<=? AND id>? ORDER BY id LIMIT 50`,
            MAX_ARTIFACT_BYTES,
            after,
          ),
        );
        if (!rows.length) break;
        for (const artifact of rows.map(fromRow)) {
          // The catch below logs the pass as stopped.
          if (this.stopped) throw new Error('stopped');
          after = artifact.id;
          try {
            const bytes = await this.fetch(artifact);
            await this.state.transaction((tx) =>
              tx.run(
                'UPDATE artifacts SET content=? WHERE id=? AND content IS NULL',
                bytes,
                artifact.id,
              ),
            );
            counts.filled++;
          } catch (error) {
            const why = code(error);
            if (why === 'blob_unavailable') throw error;
            // Lost: gone from storage, or not the bytes the row declares.
            const lost = why === 'artifact_bytes_missing' || why === 'blob_corrupt';
            counts[lost ? 'skipped' : 'failed']++;
            const event = lost ? 'artifacts.backfill_skipped' : 'artifacts.backfill_failed';
            log({ event, artifactId: artifact.id, code: why });
          }
        }
      }
    } catch (error) {
      const why = this.stopped ? 'stopped' : code(error);
      return log({ event: 'artifacts.backfill_stopped', ...counts, code: why });
    }
    const remaining = await this.state
      .read((sql) =>
        sql.get<{ count: string }>(
          'SELECT count(*) AS count FROM artifacts WHERE content IS NULL AND size<=?',
          MAX_ARTIFACT_BYTES,
        ),
      )
      .then((row) => Number(row?.count))
      .catch(() => undefined);
    log({ event: 'artifacts.backfill', ...counts, remaining });
  }
}
