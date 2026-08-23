import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTitlePrefix,
  clientLooksPresent,
  defaultPrefs,
  deriveAttention,
  eventEnabled,
  mergePrefs,
  pageIsAttentive,
  shouldAccept,
  stripTitlePrefix,
} from '../lib/derive.js'

test('deriveAttention prefers approval over questions and completed', () => {
  const prefs = defaultPrefs()
  const attention = deriveAttention([
    { id: 'a', displayTitle: 'Done one', completed: true },
    { id: 'b', displayTitle: 'Ask me', pendingInteraction: 'question' },
    { id: 'c', displayTitle: 'Need allow', pendingInteraction: 'approval' },
  ], 'z', prefs)
  assert.deepEqual(attention, {
    kind: 'approval',
    sessionId: 'c',
    displayTitle: 'Need allow',
    key: 'approval:c',
    priority: 0,
  })
})

test('deriveAttention ignores completed on the current session', () => {
  const attention = deriveAttention([
    { id: 'current', displayTitle: 'Here', completed: true },
    { id: 'other', displayTitle: 'There', completed: true },
  ], 'current', defaultPrefs())
  assert.equal(attention.sessionId, 'other')
  assert.equal(attention.kind, 'completed')
})

test('deriveAttention respects event toggles and the master switch', () => {
  const prefs = mergePrefs({
    events: { approval: false, question: true, completed: false },
  })
  const rows = [
    { id: 'a', pendingInteraction: 'approval', displayTitle: 'A' },
    { id: 'b', pendingInteraction: 'plan-review', displayTitle: 'B' },
  ]
  assert.equal(deriveAttention(rows, undefined, prefs).kind, 'plan-review')
  assert.equal(eventEnabled(mergePrefs({ enabled: false }), 'approval'), false)
  assert.equal(deriveAttention(rows, undefined, mergePrefs({ enabled: false })), null)
})

test('title prefix can be applied and stripped without eating the product title', () => {
  const prefixed = applyTitlePrefix('浏览器失焦交互优化 — DeepSeek Harness', 'approval', 'zh')
  assert.equal(prefixed, '⚠ 待审批 · 浏览器失焦交互优化 — DeepSeek Harness')
  assert.equal(stripTitlePrefix(prefixed), '浏览器失焦交互优化 — DeepSeek Harness')
  assert.equal(stripTitlePrefix(applyTitlePrefix(prefixed, 'completed', 'en')), '浏览器失焦交互优化 — DeepSeek Harness')
})

test('page attention and heartbeat presence are conservative', () => {
  assert.equal(pageIsAttentive('visible', true), true)
  assert.equal(pageIsAttentive('visible', false), false)
  assert.equal(pageIsAttentive('hidden', true), false)
  assert.equal(clientLooksPresent('visible', 1000, 2000), true)
  assert.equal(clientLooksPresent('visible', 1000, 20_000), false)
  assert.equal(clientLooksPresent('hidden', 1000, 2000), false)
  assert.equal(clientLooksPresent('visible', undefined, 2000), false)
})

test('shouldAccept dedupes the same key inside the window', () => {
  const seen = new Map()
  assert.equal(shouldAccept(seen, 'approval:a', 1000, 30_000), true)
  assert.equal(shouldAccept(seen, 'approval:a', 2000, 30_000), false)
  assert.equal(shouldAccept(seen, 'approval:a', 40_000, 30_000), true)
  assert.equal(shouldAccept(seen, 'completed:a', 40_100, 30_000), true)
})
