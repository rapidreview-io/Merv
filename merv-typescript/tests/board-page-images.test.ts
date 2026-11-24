/** A page card's pictures: which addresses a page shows, and which a draw call refuses up front. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { drawSchema } from '../packages/board/src/input.js';
import { imageSource } from '../packages/ui/web/markdown-links.js';

const ART = 'art_0123456789abcdef0123456789abcdef';

test('page images refuse unsafe sources and accept stored artifacts', () => {
  assert.ok(imageSource(ART));
  for (const address of [
    'javascript:alert(1)',
    'java\tscript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PGgxPmhpPC9oMT4=',
    'data:image/png,not-base64',
    'http://example.com/chart.png',
    'file:///Users/me/chart.png',
    '/Users/me/chart.png',
    'chart.png',
    'blob:https://example.com/1234',
    'https://user:secret@example.com/a.png',
    'art_short',
    `${ART}x`,
  ])
    assert.equal(imageSource(address), null, address);

  const page = (body: string) =>
    drawSchema.safeParse({ ops: [{ op: 'page', text: 'Chart', body }] });
  const refused = page('![chart](/Users/me/chart.png)');
  assert.equal(refused.success, false);
  assert.match(JSON.stringify(refused.error?.issues), /file on a computer/);
  assert.equal(
    page(`![chart](${ART})\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\``).success,
    true,
  );
});
