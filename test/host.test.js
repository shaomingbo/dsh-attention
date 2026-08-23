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

test('two distinct completion edges inside the dedupe window both notify', async () => {
  const { host, sent, clock } = await createHost()
  await host.handle('visibility', { visibility: 'hidden' })
  clock.now = 60_000

  await host.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  await host.onAgentStatus({ agent: { id: 's1' }, status: 'idle' })
  await host.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  await host.onAgentStatus({ agent: { id: 's1' }, status: 'idle' })
  assert.equal(sent.length, 2)
  assert.ok(sent.every((event) => event.kind === 'completed'))
})

test('the host mints one identity per edge, whatever key a client reports', async () => {
  const { host, sent, clock } = await createHost()
  clock.now = 60_000

  // Tab A and tab B invent different keys for the same observed edge.
  await host.handle('notify', { kind: 'completed', sessionId: 's1', key: 'completed:s1:tabA', sound: false })
  const echo = await host.handle('notify', { kind: 'completed', sessionId: 's1', key: 'completed:s1:tabB', sound: false })
  assert.equal(echo.value.accepted, false)
  assert.equal(echo.value.reason, 'deduped')
  assert.equal(sent.length, 1)

  // The host sees the edge itself afterwards (e.g. a recovering tab race):
  // same ordinal, still one banner.
  await host.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  await host.onAgentStatus({ agent: { id: 's1' }, status: 'idle' })
  assert.equal(sent.length, 1)

  // A genuinely new edge gets a fresh ordinal and rings again.
  await host.onAgentStatus({ agent: { id: 's1' }, status: 'running' })
  await host.onAgentStatus({ agent: { id: 's1' }, status: 'idle' })
  assert.equal(sent.length, 2)
})

test('the same client wait key reported twice is deduped with the banner fact', async () => {
  const { host, sent } = await createHost()
  await host.handle('notify', { kind: 'approval', sessionId: 's1', key: 'approval:s1:wait' })
  const dup = await host.handle('notify', { kind: 'approval', sessionId: 's1', key: 'approval:s1:wait' })
  assert.equal(dup.value.accepted, false)
  assert.equal(dup.value.reason, 'deduped')
  assert.equal(dup.value.banner, true)
  assert.equal(dup.value.native, false)
  assert.equal(sent.length, 1)
})

test('two distinct questions inside the dedupe window both notify', async () => {
  const { host, sent } = await createHost()
  await host.handle('notify', { kind: 'question', sessionId: 's1', key: 'question:s1:wait:1' })
  const second = await host.handle('notify', { kind: 'question', sessionId: 's1', key: 'question:s1:wait:2' })
  assert.equal(second.value.accepted, true)
  assert.equal(sent.length, 2)
})

test('a dedupe that delivered no banner says so, so the client falls back', async () => {
  const { host, sent, home } = await createHost()
  await host.handle('prefs.set', { prefs: { native: false } })
  const first = await host.handle('notify', {
    kind: 'completed', sessionId: 's1', key: 'completed:s1:1', sound: false,
  })
  assert.equal(first.value.accepted, true)
  assert.equal(first.value.reason, 'native-disabled')
  const resumed = await host.handle('notify', {
    kind: 'completed', sessionId: 's1', key: 'completed:s1:1', sound: false,
  })
  assert.equal(resumed.value.accepted, false)
  assert.equal(resumed.value.reason, 'deduped')
  assert.equal(resumed.value.banner, false)
  assert.equal(sent.length, 0)
  void home
})

test('a failed native send is not recorded as delivered, so a retry can fall back', async () => {
  const clock = { now: 1_000 }
  const attempts = []
  const host = createAttentionHost({
    home: await mkdtemp(join(tmpdir(), 'dsh-attention-')),
    now: () => clock.now,
    notify: async (event) => {
      attempts.push(event)
      return { ok: false, reason: 'binary-missing' }
    },
  })
  const first = await host.handle('notify', {
    kind: 'completed', sessionId: 's1', key: 'completed:s1:1', sound: false,
  })
  assert.equal(first.value.accepted, true)
  assert.equal(first.value.native, false)
  const resumed = await host.handle('notify', {
    kind: 'completed', sessionId: 's1', key: 'completed:s1:1', sound: false,
  })
  assert.equal(resumed.value.accepted, true)
  assert.equal(resumed.value.native, false)
  assert.equal(attempts.length, 2)
})

test('two tabs reporting the same window bucket produce one banner', async () => {
  const { host, sent } = await createHost()
  await host.handle('notify', {
    kind: 'completed', sessionId: 's1', key: 'completed:s1:59583', sound: false,
  })
  const echo = await host.handle('notify', {
    kind: 'completed', sessionId: 's1', key: 'completed:s1:59583', sound: false,
  })
  assert.equal(echo.value.accepted, false)
  assert.equal(echo.value.reason, 'deduped')
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

  await host.onApprovalRequest({ agent: { id: 's1' }, callId: 'c1', toolName: 'bash' }, async () => 'ok')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'approval')

  // A second ask without callId still gets its own ordinal and notifies.
  await host.onApprovalRequest({ agent: { id: 's1' }, toolName: 'bash' }, async () => 'ok')
  assert.equal(sent.length, 2)

  // The client tab reporting that same second ask collapses onto its ordinal
  // only when its key repeats; a fresh client key maps to a fresh ordinal.
  const echo = await host.handle('notify', {
    kind: 'approval', sessionId: 's1', key: 'approval:s1:tab', sound: false,
  })
  assert.equal(echo.value.accepted, true)
  assert.equal(sent.length, 3)
  const sameWait = await host.handle('notify', {
    kind: 'approval', sessionId: 's1', key: 'approval:s1:tab', sound: false,
  })
  assert.equal(sameWait.value.accepted, false)
  assert.equal(sameWait.value.reason, 'deduped')
  assert.equal(sent.length, 3)

  // First idle observation records the edge start; only running→idle fires.
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'idle' })
  assert.equal(sent.length, 3)
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'running' })
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'idle' })
  assert.equal(sent.length, 4)
  assert.equal(sent.at(-1).kind, 'completed')

  // A second completion for the same session within 30s still notifies.
  clock.now = 61_000
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'running' })
  await host.onAgentStatus({ agent: { id: 's2' }, status: 'idle' })
  assert.equal(sent.length, 5)
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
