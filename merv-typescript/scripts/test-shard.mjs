#!/usr/bin/env node
// Prints the test files of one CI shard: node scripts/test-shard.mjs <index> <count> [--exclude-lean].
// CI runs Lean conformance in its own job with the compiler and model binaries available.
// Every file lands in exactly one shard. Files are dealt out largest first, each to the shard with
// the least weight so far (ties to the lowest index); a file's weight is its size in bytes, a
// rough stand-in for its run time. The split depends only on the files, so it is deterministic.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [index, count] = process.argv.slice(2, 4).map(Number);
const excludeLean = process.argv[4] === '--exclude-lean';
if (
  !Number.isInteger(count) ||
  count < 1 ||
  !Number.isInteger(index) ||
  index < 1 ||
  index > count ||
  process.argv.length > 5 ||
  (process.argv[4] !== undefined && !excludeLean)
) {
  console.error('usage: test-shard.mjs <index> <count> [--exclude-lean], with 1 <= index <= count');
  process.exit(2);
}
const directory = 'tests';
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.test.ts'))
  .filter((name) => !excludeLean || !name.includes('-lean-'))
  .map((name) => ({ path: join(directory, name), weight: statSync(join(directory, name)).size }))
  .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : 1));
const shards = Array.from({ length: count }, () => ({ weight: 0, files: [] }));
for (const file of files) {
  const lightest = shards.reduce((best, shard) => (shard.weight < best.weight ? shard : best));
  lightest.weight += file.weight;
  lightest.files.push(file.path);
}
console.log(shards[index - 1].files.sort().join('\n'));
