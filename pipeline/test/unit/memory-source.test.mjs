// memory.mjs: the online feature source comes from generic variables
// (FEATURE_SOURCE, FEATURE_SOURCE_APP), never from one named after an app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceFor } from '../../memory.mjs';

const c = { env: 'FEATURE_SOURCE', appEnv: 'FEATURE_SOURCE_APP' };
const env = { FEATURE_SOURCE: ' https://drive.google.com/drive/folders/abc ', FEATURE_SOURCE_APP: 'acme' };

test('the source feeds only the app FEATURE_SOURCE_APP names', () => {
  assert.deepEqual(sourceFor('acme', env, c), { envVar: 'FEATURE_SOURCE', appVar: 'FEATURE_SOURCE_APP', location: 'https://drive.google.com/drive/folders/abc' });
  assert.equal(sourceFor('sample-app', env, c).location, null);
});

test('no source without both variables, and no per-app variable is read', () => {
  assert.equal(sourceFor('acme', { FEATURE_SOURCE: 'x' }, c).location, null);
  assert.equal(sourceFor('acme', { FEATURE_SOURCE_APP: 'acme' }, c).location, null);
  assert.equal(sourceFor('acme', { FEATURE_SOURCE_ACME: 'https://drive.google.com/drive/folders/abc' }, c).location, null);
});
