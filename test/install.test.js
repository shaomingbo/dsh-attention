import assert from 'node:assert/strict'
import test from 'node:test'

import { applyManifest, DEFAULT_SOURCE, PACKAGE_NAME, parseArgs } from '../bin/install.js'

test('parseArgs accepts profile and source overrides', () => {
  assert.deepEqual(parseArgs([]), { profile: 'web', source: DEFAULT_SOURCE })
  assert.deepEqual(parseArgs(['--profile', 'lab', '--source', 'link:../dsh-attention']), {
    profile: 'lab',
    source: 'link:../dsh-attention',
  })
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
})

test('applyManifest is idempotent and keeps existing bundles', () => {
  const first = applyManifest({
    dependencies: { 'dsh-file-picker': 'link:/tmp/picker' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'dsh-file-picker'] } },
  }, 'link:/tmp/attention')
  const second = applyManifest(first, 'github:shaomingbo/dsh-attention#v0.1.0')
  assert.equal(first.dependencies[PACKAGE_NAME], 'link:/tmp/attention')
  assert.deepEqual(first.dsh.profile.bundles, [
    '@deepseek-ai/dsh-web-app',
    'dsh-file-picker',
    PACKAGE_NAME,
  ])
  assert.equal(second.dsh.profile.bundles.filter((name) => name === PACKAGE_NAME).length, 1)
  assert.equal(second.dependencies[PACKAGE_NAME], 'github:shaomingbo/dsh-attention#v0.1.0')
})
