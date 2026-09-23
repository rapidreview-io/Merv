import assert from 'node:assert/strict';
import test from 'node:test';
import { clip, markdownSection, plain } from '@merv/contracts';

test('plain() detaches bounded JSON and refuses what JSON cannot carry', () => {
  const refused = (value: unknown, limits = {}) =>
    assert.throws(() => plain(value, 'invalid_input', limits), { code: 'invalid_input' });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    cycle,
    [, 1],
    [undefined],
    { x: NaN },
    { x: 1n },
    'a\0b',
    '\ud83d',
    new Date(),
    new Proxy({}, {}),
    Object.create({ inherited: true }),
    JSON.parse('{"__proto__":{"polluted":true}}'),
    Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 }),
  ])
    refused(value);
  refused({ x: 'é'.repeat(10) }, { bytes: 20 });
  refused([1, 2, 3], { nodes: 3 });
  refused({ a: { b: { c: 1 } } }, { depth: 2 });
  assert.deepEqual(plain({ a: undefined, b: [1, 'two', null], c: { d: true } }), {
    b: [1, 'two', null],
    c: { d: true },
  });
  assert.equal(plain(undefined), undefined);
  for (const value of [undefined, { x: undefined }]) refused(value, { undefined: 'reject' });
  assert.deepEqual(plain({ x: undefined }, 'invalid_input', { undefined: 'omit-root' }), {});
  refused({ nested: { x: undefined } }, { undefined: 'omit-root' });
  const escaped = { value: '\0\ud800' };
  assert.deepEqual(plain(escaped, 'invalid_input', { strings: 'json' }), escaped);
  const reserved = plain<Record<string, unknown>>(JSON.parse('{"__proto__":{"p":1}}'), 'x', {
    keys: 'any',
  });
  assert.equal(Object.hasOwn(reserved, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(reserved), Object.prototype);
});

test('plain() keeps a field-specific code for a hostile shape inside that field', () => {
  let reads = 0;
  const getter = {
    enumerable: true,
    get() {
      reads++;
      return 'x';
    },
  };
  const limits = {
    object: 'bad_root',
    fields: { route: 'bad_route', data: { code: 'bad_data', undefined: 'reject' as const } },
  };
  const refused = (value: unknown, code: string) =>
    assert.throws(() => plain(value, 'bad_input', limits), { code });
  for (const root of [
    null,
    'text',
    1,
    [],
    new Proxy({}, {}),
    Object.create({ route: 'a' }),
    undefined,
  ])
    refused(root, 'bad_root');
  refused(Object.defineProperty({}, 'route', getter), 'bad_route');
  refused({ route: new String('a') }, 'bad_route');
  refused({ data: { value: undefined } }, 'bad_data');
  refused({ other: new Proxy({}, {}) }, 'bad_input');
  refused(Object.defineProperty({}, 'other', getter), 'bad_input');
  assert.equal(reads, 0);
  assert.deepEqual(
    plain({ route: 'a', data: { value: 1 }, other: undefined }, 'bad_input', limits),
    {
      route: 'a',
      data: { value: 1 },
    },
  );
});

test('markdownSection() reads CommonMark headings in linear time', () => {
  const summary = (text: string) => markdownSection(text, 'Summary');
  assert.equal(summary('## Summary\n\n## Summary\nreal body'), 'real body');
  assert.equal(summary('## Summary ##\nreal body'), 'real body');
  assert.equal(summary('  ## Summary\nreal body'), 'real body');
  assert.equal(summary('# Summary\r\nbody\r\n# Next\r\nmore'), 'body');
  assert.equal(summary('# Summary\n### Detail\nnested\n# Next\nno'), '### Detail\nnested');
  assert.equal(summary('# Summary & findings\nbody'), 'body');
  assert.equal(summary('```\n## Summary\nfenced\n```\n## Findings\nx'), null);
  assert.equal(summary('<!-- ## Summary\nhidden -->\n## Findings\nx'), null);
  assert.equal(summary('## Summary\n\n## Findings\nx'), null);
  const started = Date.now();
  assert.equal(summary(`## Summary\n${' '.repeat(2_000_000)}x`), 'x');
  assert.equal(summary(`## Summary\n${'\n'.repeat(2_000_000)}`), null);
  assert.ok(Date.now() - started < 2_000);
});

test('clip() never ends in half a surrogate pair', () => {
  assert.equal(clip('aaa😀b', 4), 'aaa');
  assert.equal(clip('aaa😀b', 5), 'aaa😀');
  assert.equal(clip('ab', 5), 'ab');
  assert.equal(clip('😀😀', 3), '😀');
});
