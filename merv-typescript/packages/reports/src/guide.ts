/** What report.open hands an agent with its draft: the format and the review loop. */
export const REPORT_GUIDE = `Write the experiment report as one Markdown draft that Merv renders to a one-page PDF. Merv owns layout, fonts, colours and sizes; you own content. The draft persists: after a rejected submission, edit it (report.write) or start over from the plan (report.clear); never rewrite unchanged sections.

Flow: report.open → report.write (sections, front matter, data files) → report.check until no errors → report.review_visual for each chart, one at a time: look at the image, fix the spec, review again, then report.approve_visual → report.render (look at the whole page, fix, render again) → report.render with final: true. The final render stores the Markdown, the PDF and page images as artifacts; submit the Markdown artifact (sourceArtifactId) as the report.

Front matter: id, date, and criteria: one {metric: "<label>", bar: <min improvement>} or {metric: "<label>", floor: <worst allowed change>} per pre-registered success criterion. Quote metric labels. Keep labels short; they label the result chart's rows. When the approved plan set no numeric bar (an exploratory or descriptive question), keep criteria: [] and chart the measured results; never invent a bar after seeing them.

Sections, in this order (unknown headings, ### headings, captions, quotes, images and HTML are rejected):
- # title: the question, ≤16 words. Inquiry and Constraints come from the approved plan and are locked, except a locked section the plan left as only a [[write: …]] placeholder: write that one from the plan like any other section.
- Result: one bold-worthy answer line (≤15 words, no caveats), then one chart of every criterion vs its bar (with criteria: [], of the measured results that answer the question), then optionally one description paragraph (≤40 words) for nuance such as intervals that cross a bar.
- Method (≤80 words; a small table is fine), Execution (≤110 words + charts: what ran, time, cost, every deviation or incident by id), Data (a table: dataset, use, size), Verification (≤60 words), Limitations (≤4 bullets), optional Discussion (≤70 words + one chart, interpretation marked untested), optional Next (a table: proposed follow-ups with cost; mark estimates with ~), optional References (numbered list, each item ending ", YEAR"; cite inline as [n]).
Bullets stay under 25 words. Write tightly: no helper text, no restating a chart in prose. Compute every number from raw results; never estimate silently.

Charts: a fenced block \`\`\`chart with JSON {id, message, data, x, y, layer, height?, wide?}.
- message: the one sentence the chart must make obvious (not drawn).
- data: {values:[...rows]}, {file:"name.csv"} (a report data file you wrote) or {artifact:"<artifact id>"} (a CSV or JSON result artifact). Layers may have their own data.
- x, y: a field or {field, type, title, domain, zero, sort, ticks, axis, format}. title is the axis title, the only label a chart gets; axis:false hides an axis; format is d3 ("+.1f", "%a %H:%M"); a time domain takes ISO dates.
- layer (≤6): {mark: point|bar|line|area|rule|text|tick, x, x2, y, y2, color, size: s|m|l, style: solid|dashed, emphasis: low, text, where: {field, equal|oneOf|gt|lt…}, align, offset: [dx, dy] ≤40}. Channels also take {datum: v} (a fixed data value) or {value: "start"|"end"} (the chart edge); a layer placed only by those draws once.
- color: a role or {field, map: {value: role}}. Roles: result (blue, the finding), warn (orange: missed a bar, deviated), ink, baseline, muted (greys). No hex, fonts, titles or legends: label marks directly.
- With criteria, rows of the result chart need metric (matching a criterion), delta, and interval fields; Merv adds bar and status (met / not met, held / breached) from the criteria. Colour by status; never type a verdict. With criteria: [], chart the measured values and their intervals; Merv adds no bar or status.

Reviewing a chart: fix every ✗ check, weigh every !, then judge the image: what does a reader take away in five seconds, and does it match message? Is every mark and label needed? Is anything the message depends on missing? Does the eye land on the main result first?`;
