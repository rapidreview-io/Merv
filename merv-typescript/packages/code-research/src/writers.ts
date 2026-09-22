import type { StoredEvent, Transaction } from '@merv/contracts';
import { CodeWriterService, writerColumns, type WriterRow } from '@merv/code/writers';

/** Maps the research session lifecycle into durable writer transitions. */
export class ResearchCodeWriters extends CodeWriterService {
  /** The durable consumer of a session's attach and end, which open and end its generation. */
  async sessionChanged(event: StoredEvent, tx: Transaction): Promise<void> {
    const row = await tx.get<WriterRow>(
      `SELECT ${writerColumns} FROM code_units WHERE project_id=? AND writer_session_id=?`,
      event.projectId,
      event.subjectId,
    );
    if (!row) return;
    if (event.type === 'session.workspace_attached') {
      if (row.writer_state === 'reserved') await this.move(tx, row, 'active');
      return;
    }
    // A never-attached checkout needs no capture; an attached one waits for its final handoff.
    if (row.writer_state === 'reserved') await this.move(tx, row, 'closed');
    else if (row.writer_state === 'active') await this.move(tx, row, 'closing');
  }
}
