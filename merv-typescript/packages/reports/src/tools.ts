import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';
import type { RenderResult, VisualReview } from './types.js';
import {
  approveVisualSchema,
  checkSchema,
  clearSchema,
  openSchema,
  renderSchema,
  reviewVisualSchema,
  writeSchema,
} from './input.js';
import { REPORT_GUIDE } from './guide.js';

const SUBJECT = 'subjectKind is experiment or customer_experiment; subjectId is its id.';
const text = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value) });
const png = (data: string) => ({ type: 'image' as const, data, mimeType: 'image/png' });

/** The agent tools for writing, reviewing and rendering a report. */
export const reportsToolsPlugin = {
  name: 'merv-reports-tools',
  inject: ['reports', 'tools'],
  apply(ctx: Context) {
    const reports = ctx.reports;
    const register = (definition: Parameters<Context['tools']['register']>[0]) =>
      ctx.effect(() => ctx.tools.register(definition));
    register({
      name: 'report.open',
      tier: 'worker',
      became: 'report.read', // Hidden from discovery; cached calls retain domain authorization.
      description: `Open the report draft for an experiment, creating it from the approved plan the first time. Returns the draft (Markdown source, revision, data files, locked sections, chart approvals, last final render) and the report format guide. The draft persists across submissions: edit it after a review asks for changes. ${SUBJECT}`,
      inputSchema: openSchema,
      handler: async (caller, input) => ({
        ...(await reports.open(caller, input)),
        guide: REPORT_GUIDE,
      }),
    });
    register({
      name: 'report.write',
      tier: 'worker',
      description: `Edit the report draft at expectedRevision: replace section bodies by name (sections: [{name: "Result", content}]; name "title" sets the title), the front matter YAML (frontMatter), or the whole Markdown (source), and add or replace data files charts name (files: [{name: "x.csv", content}], content null removes one). Locked sections from the approved plan cannot change, except one that still holds only its [[write: …]] placeholder, which you write. Changing a chart's spec or data withdraws its approval. ${SUBJECT}`,
      inputSchema: writeSchema,
      handler: (caller, input) => reports.write(caller, input),
    });
    register({
      name: 'report.clear',
      tier: 'worker',
      description: `Start the report over: return the draft to the approved plan's prefill, removing every written section, data file and chart approval. ${SUBJECT}`,
      inputSchema: clearSchema,
      handler: (caller, input) => reports.clear(caller, input),
    });
    register({
      name: 'report.approve_visual',
      tier: 'worker',
      description: `Approve one chart at expectedRevision once its image is right. Refused while the chart has blocking checks. The approval covers the chart's spec and data as they are now. ${SUBJECT}`,
      inputSchema: approveVisualSchema,
      handler: (caller, input) => reports.approveVisual(caller, input),
    });
    register({
      name: 'report.render',
      tier: 'worker',
      description: `Render the whole report. Without final it returns page images to check the page as a whole. With final: true (and a requestId) it requires no check errors and every chart approved, then stores the Markdown source, the PDF and page images as artifacts and returns their ids: submit sourceArtifactId as the report. ${SUBJECT}`,
      inputSchema: renderSchema,
      handler: (caller, input) => reports.render(caller, input),
      present: (result) => {
        const { images, ...rest } = result as RenderResult;
        return { content: [text(rest), ...images.map(png)] };
      },
    });
    ctx.effect(() =>
      ctx.tools.noun('report.read', {
        readOnly: true,
        summary: 'Check report drafts and rendered charts.',
        description:
          'Check a report draft: check (every problem in its structure, front matter, references and charts) and review_visual (one chart rendered at its final size, with its section and automatic checks).',
        actions: {
          check: {
            description: `Check the report draft: section structure and limits, front matter criteria, references, chart specs and their data. Returns every problem and which charts are approved. ${SUBJECT}`,
            input: checkSchema,
            was: ['report.check'],
            handler: (caller, input) => reports.check(caller, input),
          },
          review_visual: {
            description: `Render one chart at its final size on the page and return its image, the image of its section on the page, and automatic checks (overlapping or cut-off labels, small text, colour and layer counts). Without chartId it reviews the next unapproved chart. Look at the images, judge them against the chart's message, fix the spec with report.write and review again before approving. ${SUBJECT}`,
            input: reviewVisualSchema,
            was: ['report.review_visual'],
            handler: (caller, input) => reports.reviewVisual(caller, input),
            present: (result) => {
              const { image, context, ...rest } = result as VisualReview;
              return { content: [text(rest), png(image), png(context)] };
            },
          },
        },
      }),
    );
  },
};
export default reportsToolsPlugin;
