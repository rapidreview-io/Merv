import { MervError, MAX_ARTIFACT_BYTES, type Artifact, type State } from '@merv/contracts';
import { META, fromRow } from './content.js';

const log = (record: object) => void process.stderr.write(`${JSON.stringify(record)}\n`);

/**
 * Temporary: moves the bytes of rows written before bytes were kept in the row into the row, so
 * reads of them stop reaching storage. Only a server whose config turns it on runs it. Rows are
 * read a page at a time; each row's bytes are fetched outside any transaction and written in a
 * short transaction of their own, which the CHECK verifies. Bytes that are gone or corrupt are
 * logged and passed over; an outage stops the pass until the next kick. Delete this, with its
 * config key, once prod has no such row left but those logged as lost.
 */
export class Backfill {
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  constructor(
    private state: State,
    /** The verified bytes of a row without content, from blobs or large storage. */
    private fetch: (artifact: Artifact) => Promise<Buffer>,
    /** Whether large storage is bound; while it is not, rows of its objects wait. */
    private bound: () => boolean,
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
    let filled = 0;
    let skipped = 0;
    try {
      for (let after = ''; ;) {
        const objects = this.bound() ? '' : ' AND object_id IS NULL';
        const rows = await this.state.read((sql) =>
          sql.all(
            `SELECT ${META} FROM artifacts WHERE content IS NULL AND size<=? AND id>?${objects} ORDER BY id LIMIT 50`,
            MAX_ARTIFACT_BYTES,
            after,
          ),
        );
        if (!rows.length) break;
        for (const artifact of rows.map(fromRow)) {
          if (this.stopped) return;
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
            filled++;
          } catch (error) {
            if (error instanceof MervError && error.code === 'blob_unavailable') throw error;
            skipped++;
            log({
              event: 'artifacts.backfill_skipped',
              artifactId: artifact.id,
              code: code(error),
            });
          }
        }
      }
    } catch (error) {
      if (!this.stopped)
        log({ event: 'artifacts.backfill_stopped', filled, skipped, code: code(error) });
      return;
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
    log({ event: 'artifacts.backfill', filled, skipped, remaining });
  }
}
/** What went wrong, without a message that might quote the row. */
const code = (error: unknown) =>
  error instanceof MervError ? error.code : error instanceof Error ? error.name : 'unknown';
