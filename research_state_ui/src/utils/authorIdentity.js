// Stable visual identity for feed voices. A handle hashes to a deterministic,
// horizontally symmetric 5×5 grid — the "machine mark" the feed shows in
// monochrome next to the name. The hash is avalanched so near-identical
// handles ("agent-1"/"agent-2") still land on different marks.

function markBits(handle) {
  let h = 0x811c9dc5;
  for (const ch of String(handle || '')) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0;
}

// Filled cells of the mark as [column, row] pairs on a 5×5 grid. The left
// three columns come from hash bits and mirror onto the right two, so every
// mark reads as one symmetric glyph; the center cell is always filled so a
// mark is never empty or a lone speck.
export function markCells(handle) {
  const bits = markBits(handle);
  const cells = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const on = (col === 1 && row === 2) || ((bits >>> (row * 3 + col)) & 1) === 1;
      if (!on) continue;
      cells.push([col, row]);
      if (col < 2) cells.push([4 - col, row]);
    }
  }
  return cells;
}
