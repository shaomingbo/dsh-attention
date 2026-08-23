import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { buildNativeCommand, buildSoundCommand, clipText, notifyNative, osaQuote, soundFileFor, spawnDetached, xmlEscape } from '../lib/native.js'
import { encodeWav, renderChimePcm, wavBufferFor } from '../lib/sounds/render.js'

function fakeSpawn(behavior) {
  return () => {
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => behavior(child))
    return child
  }
}

test('macOS banner stays silent so the custom chime can play', () => {
  const spec = buildNativeCommand('darwin', { title: 'Wait "now"', body: 'Need approval', kind: 'approval' })
  assert.equal(spec.command, 'osascript')
  assert.match(spec.args[1], /Need approval/)
  assert.match(spec.args[1], /Wait \\"now\\"/)
  assert.doesNotMatch(spec.args[1], /sound name/)
})

test('linux and windows adapters pick local helpers', () => {
  const linux = buildNativeCommand('linux', { title: 'Done', body: 'Task completed' })
  assert.equal(linux.command, 'notify-send')
  const windows = buildNativeCommand('win32', { title: 'Done', body: 'Task completed' })
  assert.equal(windows.command, 'powershell')
  assert.match(windows.args.at(-1), /ToastNotification/)
  assert.equal(buildNativeCommand('sunos', { title: 'x', body: 'y' }), null)
})

test('sound playback uses the bundled chime files', () => {
  assert.match(soundFileFor('approval'), /approval\.wav$/)
  assert.match(soundFileFor('question'), /approval\.wav$/)
  assert.match(soundFileFor('completed'), /completed\.wav$/)
  const mac = buildSoundCommand('darwin', '/tmp/complete.wav')
  assert.deepEqual(mac, { command: 'afplay', args: ['-v', '0.55', '/tmp/complete.wav'] })
})

test('rendered chimes are valid short wavs', () => {
  const wav = wavBufferFor('completed')
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE')
  assert.ok(wav.length > 1000)
  assert.equal(encodeWav(renderChimePcm('approval')).subarray(8, 12).toString(), 'WAVE')
})

test('spawnDetached waits for the kernel spawn before claiming success', async () => {
  const ok = await spawnDetached('afplay', ['x.wav'], fakeSpawn((child) => child.emit('spawn')))
  assert.equal(ok.ok, true)

  const enoent = await spawnDetached('notify-send', ['x'], fakeSpawn((child) => {
    const error = new Error('spawn notify-send ENOENT')
    error.code = 'ENOENT'
    child.emit('error', error)
  }))
  assert.equal(enoent.ok, false)
  assert.equal(enoent.error.code, 'ENOENT')

  const thrown = await spawnDetached('boom', [], () => {
    throw new Error('no exec')
  })
  assert.equal(thrown.ok, false)
})

test('a missing native binary reports failure so the browser fallback engages', async () => {
  const failing = fakeSpawn((child) => {
    const error = new Error('spawn osascript ENOENT')
    error.code = 'ENOENT'
    child.emit('error', error)
  })
  const banner = await notifyNative(
    { title: 'Done', body: 'Finished', kind: 'completed' },
    { platform: 'darwin', spawn: failing },
  )
  assert.equal(banner.ok, false)
  assert.equal(banner.reason, 'binary-missing')

  const player = fakeSpawn((child) => child.emit('spawn'))
  const withSound = await notifyNative(
    { title: 'Done', body: 'Finished', kind: 'completed' },
    { platform: 'darwin', spawn: player },
  )
  assert.equal(withSound.ok, true)
  assert.equal(withSound.sound, true)

  const silent = await notifyNative(
    { title: 'Done', body: 'Finished', kind: 'completed', sound: false },
    { platform: 'darwin', spawn: player },
  )
  assert.equal(silent.ok, true)
  assert.equal(silent.sound, false)
})

test('text helpers clip and escape', () => {
  assert.equal(clipText('  a\n\nb  '), 'a b')
  assert.equal(clipText('x'.repeat(10), 4), 'xxx…')
  assert.equal(osaQuote('say "hi"'), '"say \\"hi\\""')
  assert.equal(xmlEscape('<&>'), '&lt;&amp;&gt;')
})
