import { test } from 'node:test';
import assert from 'node:assert/strict';

import { versionSkew } from './verify-ai-memory.mjs';

test('equal versions match', () => {
  assert.deepEqual(versionSkew('ai-memory 2.0.0', 'ai-memory 2.0.0'), {
    skew: 'match',
    container: '2.0.0',
    native: '2.0.0',
  });
});

test('same major, different minor is drift', () => {
  assert.equal(versionSkew('2.0.0', '2.3.1').skew, 'drift');
});

test('different majors are the unsupported mix', () => {
  assert.equal(versionSkew('ai-memory 1.25.0', 'ai-memory 2.0.0').skew, 'major');
  assert.equal(versionSkew('2.0.0', '1.38.0').skew, 'major');
});

test('a missing side cannot be compared', () => {
  assert.equal(versionSkew(undefined, '2.0.0').skew, null);
  assert.equal(versionSkew('2.0.0', 'no version here').skew, null);
  assert.equal(versionSkew('2.0.0', 'exit 127').skew, null);
});

test('versions are extracted from surrounding CLI output', () => {
  const { container, native } = versionSkew('ai-memory 1.25.0\n', '  ai-memory 1.38.0');
  assert.equal(container, '1.25.0');
  assert.equal(native, '1.38.0');
});
