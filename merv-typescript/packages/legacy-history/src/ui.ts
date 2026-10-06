import type { Context } from 'cordis';
import { z } from 'zod';
import { check, idSchema, MervError, type Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import { legacyHistoryTypes, type LegacyHistoryType } from './history.js';
import { historyMediaLinks } from './media-links.js';
import type {} from './types.js';

const recordType = z.enum(legacyHistoryTypes);
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('summary') }).strict(),
  z
    .object({
      action: z.literal('list'),
      type: recordType,
      after: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('detail'), type: recordType, id: z.string().min(1).max(4096) })
    .strict(),
]);

/** The categories a person reads, as the page's tabs name them, in tab order. */
const TABS: { type: LegacyHistoryType; label: string }[] = [
  { type: 'experiments', label: 'Experiments' },
  { type: 'tasks', label: 'Tasks' },
  { type: 'reflections', label: 'Reflections' },
  { type: 'claims', label: 'Claims' },
  { type: 'litreview_sections', label: 'Literature' },
  { type: 'papers', label: 'Papers' },
  { type: 'posts', label: 'Feed' },
];
/** What a record's page reads first, by type, each field under its heading; the whole record stays one fold away. */
const READING: Partial<Record<LegacyHistoryType, string[]>> = {
  experiments: ['intent', 'conclusion', 'details', 'revision_context'],
  tasks: ['goal', 'outcome', 'deliverables_json', 'revision_context'],
  reflections: ['revision_context'],
  claims: ['statement', 'scope', 'confidence'],
  litreview_sections: ['tldr', 'body'],
  papers: ['description', 'authors_json', 'year', 'url'],
  posts: ['text'],
  reviews: ['synopsis', 'verdict', 'notes', 'findings_json', 'evidence_json'],
  consolidation_proposals: ['summary'],
  consolidation_decisions: ['disposition', 'rationale'],
};
const readingOf = (type: LegacyHistoryType) =>
  (READING[type] ?? ['summary', 'description', 'notes']).map((field) => ({
    field,
    label: field === 'tldr' ? 'Summary' : field.replace(/_json$/, '').replaceAll('_', ' '),
  }));

/** The archive's page for one imported source; no agent tool or live workflow adapter. */
export const legacyHistoryUiPlugin = {
  name: 'merv-legacy-history-ui',
  Config: z.object({ sourceId: idSchema }).strict(),
  inject: ['legacyHistory', 'ui'],
  apply(ctx: Context, config: { sourceId: string }) {
    const history = ctx.legacyHistory;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'legacy-history',
        label: 'Previous research',
        group: 'research',
        order: 19,
        path: '/legacy-history',
        whenCounted: true,
        view: { kind: 'legacy-history' },
        status: async (caller) => {
          try {
            const summary = await history.summary(caller, config);
            return { count: Object.values(summary.counts).reduce((sum, count) => sum + count, 0) };
          } catch (error) {
            if (error instanceof MervError && error.code === 'legacy_history_not_found')
              return { count: 0, detail: 'No previous research was imported for this project.' };
            throw error;
          }
        },
        read: async (caller, params) => {
          const parsed = request.safeParse(params ?? { action: 'summary' });
          check(parsed.success, 'invalid_input', 'History query is invalid');
          const input = parsed.data;
          if (input.action === 'summary')
            return { ...(await history.summary(caller, config)), tabs: TABS } as unknown as Json;
          if (input.action === 'list') {
            const { action: _action, ...query } = input;
            return (await history.list(caller, { ...query, ...config })) as unknown as Json;
          }
          const { action: _action, ...query } = input;
          const record = await history.detail(caller, { ...query, ...config });
          return {
            ...record,
            files: historyMediaLinks(record.type, record.id, record.data, caller.projectId),
            reading: readingOf(record.type),
          } as unknown as Json;
        },
      }),
    );
  },
};
export default legacyHistoryUiPlugin;
