import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedUrl, origin } from '@merv/contracts';

test('one origin rule: https, or http on loopback only, with no credentials, query or fragment', () => {
  for (const [value, named] of [
    ['https://sandboxes.example', 'https://sandboxes.example'],
    ['https://sandboxes.example/', 'https://sandboxes.example'],
    ['https://Sandboxes.Example:443', 'https://sandboxes.example'],
    ['http://localhost:4000', 'http://localhost:4000'],
    ['http://127.0.0.1:9/', 'http://127.0.0.1:9'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
  ])
    assert.equal(origin(value, 'bad', 'Bad'), named, value);
  for (const value of [
    undefined,
    '',
    'sandboxes.example',
    'http://sandboxes.example',
    'http://10.0.0.1',
    'ftp://sandboxes.example',
    'https://user:pw@sandboxes.example',
    'https://sandboxes.example/v1',
    'https://sandboxes.example?namespace=other',
    'https://sandboxes.example/?',
    'https://sandboxes.example#top',
    'https://sandboxes.example\n',
    ' https://sandboxes.example',
  ])
    assert.throws(() => origin(value, 'bad_origin', 'Bad', 503), {
      code: 'bad_origin',
      status: 503,
    });
  // A URL keeps its path, under the same origin rule.
  assert.ok(allowedUrl('https://mcp.example/servers/one'));
  assert.ok(allowedUrl('http://127.0.0.1:3000/mcp'));
  for (const value of [
    'http://mcp.example/mcp',
    'https://user@mcp.example/mcp',
    'https://mcp.example/mcp?token=secret',
    'https://mcp.example/a b',
    'not a url',
  ])
    assert.equal(allowedUrl(value), false, value);
});
