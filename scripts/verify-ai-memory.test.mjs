import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unhealthyProviders, versionSkew, wikiFreezeSignature } from './verify-ai-memory.mjs';

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

test('null error fields do not make a provider unhealthy', () => {
  const providers = {
    llm: { status: 'unknown', last_error_at: null, last_error_message: null },
    embedding: { status: 'ok', last_error_message: null },
  };
  assert.deepEqual(unhealthyProviders(providers), []);
});

test('a recorded error message or bad status is unhealthy', () => {
  const sick = unhealthyProviders({
    llm: { status: 'unhealthy', last_error_message: '401 unauthorized' },
    embedding: { status: 'ok', last_error_message: null },
  });
  assert.equal(sick.length, 1);
  assert.match(sick[0], /llm: unhealthy \(401 unauthorized\)/);
});

test('a status without a structured provider block cannot be judged', () => {
  assert.equal(unhealthyProviders(undefined), null);
  assert.equal(unhealthyProviders('text'), null);
});

test('a clean wiki has no freeze signature', () => {
  assert.equal(wikiFreezeSignature(0, 0), 'ok');
});

test('zero-size loose objects or libgit2 parse errors mean frozen', () => {
  assert.equal(wikiFreezeSignature(1, 0), 'frozen');
  assert.equal(wikiFreezeSignature(0, 3), 'frozen');
  assert.equal(wikiFreezeSignature(13, 738), 'frozen');
});

test('versions are extracted from surrounding CLI output', () => {
  const { container, native } = versionSkew('ai-memory 1.25.0\n', '  ai-memory 1.38.0');
  assert.equal(container, '1.25.0');
  assert.equal(native, '1.38.0');
});
