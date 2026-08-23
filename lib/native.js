import { spawn } from 'node:child_process'

const MAX_TEXT = 180

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
    const xml = `<toast><visual><binding template="ToastText02"><text id="1">${xmlEscape(title)}</text><text id="2">${xmlEscape(body)}</text></binding></visual></toast>`
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

export function spawnDetached(command, args, spawnImpl = spawn) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(command, args, { stdio: 'ignore', detached: true })
    } catch (error) {
      resolve({ ok: false, error })
      return
    }
    child.on('error', (error) => resolve({ ok: false, error }))
    child.unref?.()
    // Native notifiers return as soon as the helper accepts the request.
    resolve({ ok: true, child })
  })
}

export async function notifyNative(event, options = {}) {
  const platform = options.platform ?? process.platform
  const spec = buildNativeCommand(platform, event)
  if (spec === null) return { ok: false, reason: 'unsupported-platform' }
  const result = await spawnDetached(spec.command, spec.args, options.spawn)
  if (!result.ok) return { ok: false, reason: 'spawn-failed', error: result.error }
  return { ok: true, command: spec.command }
}
