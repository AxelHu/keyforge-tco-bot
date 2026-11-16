import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LEGACY_PREJOIN_GUARD_HASHES } from '../../tools/keyteki-reconcile-unjoined.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('bounded unjoined recovery pins match this published package guard version', () => {
  assert.equal(Object.keys(LEGACY_PREJOIN_GUARD_HASHES).length, 4);
  for (const [name, expected] of Object.entries(LEGACY_PREJOIN_GUARD_HASHES)) {
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(path.join(root, name)))
        .digest('hex'),
      expected,
      name,
    );
  }
});
