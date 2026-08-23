import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNativeCommand, clipText, osaQuote, xmlEscape } from '../lib/native.js'

test('macOS command uses osascript and quotes the payload', () => {
  const spec = buildNativeCommand('darwin', { title: 'Wait "now"', body: 'Need approval' })
  assert.equal(spec.command, 'osascript')
  assert.equal(spec.args[0], '-e')
  assert.match(spec.args[1], /display notification/)
  assert.match(spec.args[1], /Need approval/)
  assert.match(spec.args[1], /Wait \\"now\\"/)
})

test('linux and windows adapters pick local helpers', () => {
  const linux = buildNativeCommand('linux', { title: 'Done', body: 'Task completed' })
  assert.deepEqual(linux.command, 'notify-send')
  assert.equal(linux.args[0], '--app-name=DeepSeek Harness')
  const windows = buildNativeCommand('win32', { title: 'Done', body: 'Task completed' })
  assert.equal(windows.command, 'powershell')
  assert.match(windows.args.at(-1), /ToastNotification/)
  assert.equal(buildNativeCommand('sunos', { title: 'x', body: 'y' }), null)
})

test('text helpers clip and escape', () => {
  assert.equal(clipText('  a\n\nb  '), 'a b')
  assert.equal(clipText('x'.repeat(10), 4), 'xxx…')
  assert.equal(osaQuote('say "hi"'), '"say \\"hi\\""')
  assert.equal(xmlEscape('<&>'), '&lt;&amp;&gt;')
})
