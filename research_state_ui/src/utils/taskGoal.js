/**
 * composeGoal — the Goal text a task is created with, in the shape the brief
 * and the task page read as structure (mirrors evidence.goal_parts on the
 * server): one headline line, "Deliver:" with a bullet per thing that will
 * exist, and a "So that <why>" purpose sentence. Empty parts are left out, so
 * a summary alone is still a valid (plain) goal.
 */
export function composeGoal({ summary, deliverables, purpose }) {
  const items = String(deliverables || '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  let why = String(purpose || '').trim().replace(/^so that\s+/i, '');
  if (why) why = why[0].toLowerCase() + why.slice(1);
  const parts = [String(summary || '').trim()];
  if (items.length) parts.push(['Deliver:', ...items.map(i => `- ${i}`)].join('\n'));
  if (why) parts.push(`So that ${why}`);
  return parts.filter(Boolean).join('\n\n');
}
