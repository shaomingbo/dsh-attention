import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, CHANNEL, createAttentionHost, inject } from '../lib/index.js'

function createHarness(hostOptions = {}) {
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
  return { channel, handler, listeners, options, hostOptions }
}

test('registers the loopback RPC channel and required inject', () => {
  const harness = createHarness()
  assert.deepEqual(inject, ['connection'])
  assert.equal(harness.channel, CHANNEL)
  assert.deepEqual(harness.options, { authority: 'loopback' })
  assert.equal(typeof harness.listeners.get('approval/request'), 'function')
  assert.equal(typeof harness.listeners.get('agent/status'), 'function')
})

test('client notify dispatches once and persists prefs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attention-'))
  const sent = []
  const clock = { now: 1_000 }
  const host = createAttentionHost({
    home,
    now: () => clock.now,
    notify: async (event) => {
      sent.push(event)
      return { ok: true }
    },
  })

  const first = await host.handle('notify', {
    kind: 'approval',
    sessionId: 's1',
    title: 'Waiting for approval',
    body: 'Need allow',
    key: 'approval:s1',
  })
  assert.equal(first.ok, true)
  assert.equal(first.value.accepted, true)
  assert.equal(first.value.native, true)
  assert.equal(sent.length, 1)

  const dup = await host.handle('notify', {
    kind: 'approval',
    sessionId: 's1',
    key: 'approval:s1',
  })
  assert.equal(dup.value.accepted, false)
  assert.equal(dup.value.reason, 'deduped')
  assert.equal(sent.length, 1)

  await host.handle('prefs.set', { prefs: { sound: false, events: { completed: false } } })
  const stored = JSON.parse(await readFile(join(home, 'attention.json'), 'utf8'))
  assert.equal(stored.sound, false)
  assert.equal(stored.events.completed, false)
  assert.equal(stored.enabled, true)
})

test('backup listeners skip when the client is visible and always call next', async () => {
  const sent = []
  const clock = { now: 5_000 }
  const host = createAttentionHost({
    home: await mkdtemp(join(tmpdir(), 'dsh-attention-')),
    now: () => clock.now,
    notify: async (event) => {
      sent.push(event)
      return { ok: true }
    },
  })
  await host.handle('visibility', { visibility: 'visible' })

  let nextCalls = 0
  const outcome = await host.onApprovalRequest({
    agent: { id: 's1' },
    toolName: 'bash',
  }, async () => {
    nextCalls += 1
    return { decision: 'allow' }
  })
  assert.equal(outcome.decision, 'allow')
  assert.equal(nextCalls, 1)
  assert.equal(sent.length, 0)

  await host.handle('visibility', { visibility: 'hidden' })
  clock.now = 6_000
  await host.onApprovalRequest({ agent: { id: 's1' }, toolName: 'bash' }, async () => 'ok')
  assert.equal(sent.length, 1)
  assert.match(sent[0].body, /bash/)

  clock.now = 50_000
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'idle' })
  assert.equal(sent.at(-1).kind, 'completed')
})

test('approval next still runs when notify throws', async () => {
  const host = createAttentionHost({
    home: await mkdtemp(join(tmpdir(), 'dsh-attention-')),
    notify: async () => {
      throw new Error('boom')
    },
  })
  const result = await host.onApprovalRequest({ sessionId: 's9', toolName: 'edit' }, async () => 'continued')
  assert.equal(result, 'continued')
})
