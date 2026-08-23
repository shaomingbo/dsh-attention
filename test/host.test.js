import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, CHANNEL, createAttentionHost, inject } from '../lib/index.js'

function createHarness() {
  const listeners = new Map()
  let handler
  let channel
  let options
  apply({
    connection: {
      rpc: {
        handle(nextChannel, nextHandler, nextOptions) {
          channel = nextChannel
          handler = nextHandler
          options = nextOptions
          return async () => {}
        },
      },
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    logger: { warn() {} },
  })
  return { channel, handler, listeners, options }
}

async function createHost(overrides = {}) {
  const sent = []
  const clock = { now: 1_000 }
  const home = await mkdtemp(join(tmpdir(), 'dsh-attention-'))
  const host = createAttentionHost({
    home,
    now: () => clock.now,
    notify: async (event) => {
      sent.push(event)
      return { ok: true }
    },
    ...overrides,
  })
  return { host, sent, clock, home }
}

test('registers the loopback RPC channel and required inject', () => {
  const harness = createHarness()
  assert.deepEqual(inject, ['connection'])
  assert.equal(harness.channel, CHANNEL)
  assert.deepEqual(harness.options, { authority: 'loopback' })
  assert.equal(typeof harness.listeners.get('approval/request'), 'function')
  assert.equal(typeof harness.listeners.get('agent/status'), 'function')
})

test('client notify requires a unique key and persists prefs', async () => {
  const { host, sent, home } = await createHost()

  const first = await host.handle('notify', {
    kind: 'approval',
    sessionId: 's1',
    title: 'Waiting for approval',
    body: 'Need allow',
    key: 'approval:s1:a1',
  })
  assert.equal(first.ok, true)
  assert.equal(first.value.accepted, true)
  assert.equal(first.value.native, true)
  assert.equal(sent.length, 1)

  await assert.rejects(
    () => host.handle('notify', { kind: 'approval', sessionId: 's1' }),
    /key must be a non-empty string/,
  )

  await host.handle('prefs.set', { prefs: { sound: false, events: { completed: false } } })
  const stored = JSON.parse(await readFile(join(home, 'attention.json'), 'utf8'))
  assert.equal(stored.sound, false)
  assert.equal(stored.events.completed, false)
  assert.equal(stored.enabled, true)
})

test('two distinct completions inside the dedupe window both notify', async () => {
  const { host, sent, clock } = await createHost()

  const first = await host.handle('notify', {
    kind: 'completed', sessionId: 's1', key: 'completed:s1:1', sound: false,
  })
  const second = await host.handle('notify', {
    kind: 'completed', sessionId: 's1', key: 'completed:s1:2', sound: false,
  })
  assert.equal(first.value.accepted, true)
  assert.equal(second.value.accepted, true)
  assert.equal(sent.length, 2)
  assert.equal(clock.now, 1_000)
})

test('the same key delivered twice is deduped and reports no banner', async () => {
  const { host, sent } = await createHost()
  await host.handle('notify', { kind: 'approval', sessionId: 's1', key: 'approval:s1:a1' })
  const dup = await host.handle('notify', { kind: 'approval', sessionId: 's1', key: 'approval:s1:a1' })
  assert.equal(dup.value.accepted, false)
  assert.equal(dup.value.reason, 'deduped')
  assert.equal(dup.value.native, false)
  assert.equal(sent.length, 1)
})

test('a fresh heartbeat defers every backup to the live client', async () => {
  const { host, sent, clock } = await createHost()
  await host.handle('visibility', { visibility: 'hidden' })
  clock.now = 4_000

  let nextCalls = 0
  const outcome = await host.onApprovalRequest({
    agent: { id: 's1' },
    id: 'a1',
    toolName: 'bash',
  }, async () => {
    nextCalls += 1
    return { decision: 'allow' }
  })
  assert.equal(outcome.decision, 'allow')
  assert.equal(nextCalls, 1)
  assert.equal(sent.length, 0)

  await host.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  await host.onAgentStatus({ agent: { id: 's1' }, status: 'idle' })
  assert.equal(sent.length, 0)
})

test('a stale heartbeat lets the backup fire, once per running→idle edge', async () => {
  const { host, sent, clock } = await createHost()
  await host.handle('visibility', { visibility: 'hidden' })
  clock.now = 60_000

  await host.onApprovalRequest({ agent: { id: 's1' }, id: 'a1', callId: 'c1', toolName: 'bash' }, async () => 'ok')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'approval')

  // Replayed duplicate of the same approval event: deduped.
  await host.onApprovalRequest({ agent: { id: 's1' }, id: 'a1', callId: 'c1', toolName: 'bash' }, async () => 'ok')
  assert.equal(sent.length, 1)

  // First idle observation records the edge start; only running→idle fires.
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'idle' })
  assert.equal(sent.length, 1)
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'running' })
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'idle' })
  assert.equal(sent.length, 2)
  assert.equal(sent.at(-1).kind, 'completed')

  // A second completion for the same session within 30s still notifies.
  clock.now = 61_000
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'running' })
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'idle' })
  assert.equal(sent.length, 3)
})

test('approval next still runs when notify throws', async () => {
  const host = createAttentionHost({
    home: await mkdtemp(join(tmpdir(), 'dsh-attention-')),
    notify: async () => {
      throw new Error('boom')
    },
  })
  const result = await host.onApprovalRequest({ sessionId: 's9', id: 'a9', toolName: 'edit' }, async () => 'continued')
  assert.equal(result, 'continued')
})
