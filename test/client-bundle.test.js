import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

test('browser bundle uses the DSH client-module handoff and required slots', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/)
  assert.match(source, /id: 'dsh-attention'/)
  assert.match(source, /shell\.overlay/)
  assert.match(source, /settings\.section/)
  assert.match(source, /connection\.rpc\.call/)
  assert.match(source, /CHANNEL = '\/attention'/)
})

test('browser bundle implements title, favicon, sound, and notification fallback', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /document\.title/)
  assert.match(source, /MutationObserver/)
  assert.match(source, /toDataURL/)
  assert.match(source, /AudioContext/)
  assert.match(source, /Notification\.requestPermission/)
  assert.match(source, /pendingInteraction/)
  assert.match(source, /nativeAvailable/)
  assert.match(source, /pageIsAttentive/)
})
