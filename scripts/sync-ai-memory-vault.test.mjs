import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignVaultNames, metaValue, sanitizeName } from './sync-ai-memory-vault.mjs';

test('metaValue reads a frontmatter key', () => {
  const meta = '---\nproject: my-configs\ntype: Scope Manifest\n---\n';
  assert.equal(metaValue(meta, 'project'), 'my-configs');
  assert.equal(metaValue(meta, 'workspace'), null);
});

test('metaValue strips surrounding quotes', () => {
  assert.equal(metaValue('project: "quoted name"\n', 'project'), 'quoted name');
});

test('sanitizeName removes path separators and leading dots', () => {
  assert.equal(sanitizeName('a/b\\c:d'), 'a-b-c-d');
  assert.equal(sanitizeName('.hidden'), 'hidden');
  assert.equal(sanitizeName('My Project'), 'My Project');
});

test('sanitizeName has nothing to say about an empty name', () => {
  assert.equal(sanitizeName(''), null);
  assert.equal(sanitizeName(null), null);
  assert.equal(sanitizeName('...'), null);
});

test('unique names survive a project-name collision', () => {
  const names = assignVaultNames([
    { uuid: '019aaaaa-1111', name: 'realtime-voice-chat' },
    { uuid: '019bbbbb-2222', name: 'realtime-voice-chat' },
    { uuid: '019ccccc-3333', name: 'my-configs' },
  ]);
  assert.equal(names.get('019aaaaa-1111'), 'realtime-voice-chat');
  assert.equal(names.get('019bbbbb-2222'), 'realtime-voice-chat (019bbbbb)');
  assert.equal(names.get('019ccccc-3333'), 'my-configs');
});

test('a project without a readable name falls back to its uuid', () => {
  const names = assignVaultNames([{ uuid: '019dddd-4444', name: null }]);
  assert.equal(names.get('019dddd-4444'), '019dddd-4444');
});
