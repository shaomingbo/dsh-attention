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
  assert.match(source, /--dsw-alias-bg-layer-2/)
  assert.match(source, /--dsw-alias-label-primary/)
  assert.match(source, /1175/)
  assert.match(source, /988/)
})

test('completions fire on the running edge with unique keys and no debug hooks', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /previous === true && row\.running === false/)
  assert.match(source, /fireCompleted/)
  assert.match(source, /fireSeq\.current \+= 1/)
  assert.doesNotMatch(source, /__DSH_ATTENTION_TEST/)
})

test('blocking waits release the tab title and re-arm the next occurrence', async () => {
  const source = await readFile(clientPath, 'utf8')
  // Clearing branch runs when the plugin is off, nothing blocks, or the user
  // is looking; lastKey resets so the same session can ring again.
  assert.match(source, /if \(flashTimer\.current === null\) \{/)
  assert.match(source, /if \(attention === null\) lastKey\.current = null/)
  assert.match(source, /bannerHandled = await notifyHost/)
  assert.match(source, /result\.native === true \|\| result\.reason === 'deduped'/)
  assert.match(source, /sound: false,/)
})
