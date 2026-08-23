import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chimeKind } from './sounds/render.js'

const MAX_TEXT = 180
const SOUNDS_DIR = dirname(fileURLToPath(import.meta.url))

export function clipText(value, limit = MAX_TEXT) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

export function osaQuote(value) {
  return `"${clipText(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function xmlEscape(value) {
  return clipText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function soundFileFor(kind) {
  return join(SOUNDS_DIR, 'sounds', `${chimeKind(kind)}.wav`)
}

export function buildNativeCommand(platform, event) {
  const title = clipText(event.title || 'DeepSeek Harness', 80)
  const body = clipText(event.body || '', 160)
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', `display notification ${osaQuote(body)} with title ${osaQuote(title)}`],
    }
  }
  if (platform === 'linux') {
    return {
      command: 'notify-send',
      args: ['--app-name=DeepSeek Harness', title, body],
    }
  }
  if (platform === 'win32') {
    const xml = `<toast><audio silent="true"/><visual><binding template="ToastText02"><text id="1">${xmlEscape(title)}</text><text id="2">${xmlEscape(body)}</text></binding></visual></toast>`
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$xml.LoadXml('${xml.replaceAll("'", "''")}')`,
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DeepSeek Harness').Show($toast)",
    ].join('; ')
    return {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
    }
  }
  return null
}

export function buildSoundCommand(platform, file) {
  if (platform === 'darwin') return { command: 'afplay', args: ['-v', '0.55', file] }
  if (platform === 'linux') return { command: 'paplay', args: [file] }
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer '${file.replaceAll("'", "''")}').PlaySync()`],
    }
  }
  return null
}

export function spawnDetached(command, args, spawnImpl = spawn) {
  return new Promise((resolve) => {
    let settled = false
    let child
    const settle = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      child = spawnImpl(command, args, { stdio: 'ignore', detached: true })
    } catch (error) {
      settle({ ok: false, error })
      return
    }
    // Wait for the kernel-side spawn (or its failure) before claiming
    // success: a missing binary reports ENOENT via 'error', never 'spawn'.
    child.once('spawn', () => {
      child.unref?.()
      settle({ ok: true, child })
    })
    child.once('error', (error) => settle({ ok: false, error }))
  })
}

export async function notifyNative(event, options = {}) {
  const platform = options.platform ?? process.platform
  const spec = buildNativeCommand(platform, event)
  if (spec === null) return { ok: false, reason: 'unsupported-platform' }
  const spawnImpl = options.spawn ?? spawn
  const result = await spawnDetached(spec.command, spec.args, spawnImpl)
  if (!result.ok) {
    const code = result.error?.code
    return { ok: false, reason: code === 'ENOENT' ? 'binary-missing' : 'spawn-failed', error: result.error }
  }
  let soundPlayed = false
  if (event.sound !== false) {
    const sound = buildSoundCommand(platform, options.soundFile ?? soundFileFor(event.kind))
    if (sound) soundPlayed = (await spawnDetached(sound.command, sound.args, spawnImpl)).ok
  }
  return { ok: true, command: spec.command, sound: soundPlayed }
}
