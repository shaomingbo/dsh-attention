/**
 * Host half of dsh-attention: loopback RPC, preference file, native OS
 * notifications, and fail-open listeners on approval/status events.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  clientAlive,
  defaultPrefs,
  eventEnabled,
  localizeKind,
  mergePrefs,
  shouldAccept,
} from './derive.js'
import { notifyNative } from './native.js'

export const CHANNEL = '/attention'
export const inject = ['connection']

function failure(message, code = 'internal') {
  return {
    ok: false,
    error: { code, message, details: {} },
  }
}

function success(value) {
  return { ok: true, value }
}

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('request payload must be an object')
  }
  return payload
}

function requireString(value, field, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function dshHome() {
  return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
}

export function prefsPathFor(home = dshHome()) {
  return join(home, 'attention.json')
}

export function createAttentionHost(options = {}) {
  const home = options.home ?? dshHome()
  const path = options.prefsPath ?? prefsPathFor(home)
  const now = options.now ?? (() => Date.now())
  const notify = options.notify ?? ((event) => notifyNative(event, options))
  const log = options.log ?? (() => {})
  const seenAt = new Map()
  /** Per-session completion ordinal: one unique key per running→idle edge. */
  const completionSeq = new Map()
  /** Last agent status per session; only the running→idle edge notifies. */
  const prevStatus = new Map()
  let prefs = defaultPrefs()
  let loaded = false
  let nativeAvailable = true
  let heartbeatAt

  async function loadPrefs() {
    if (loaded) return prefs
    loaded = true
    try {
      prefs = mergePrefs(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (error && error.code !== 'ENOENT') log(`attention prefs read failed: ${error.message}`)
      prefs = defaultPrefs()
    }
    return prefs
  }

  async function savePrefs(next) {
    prefs = mergePrefs(next)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
    return prefs
  }

  function markVisibility(nextVisibility) {
    heartbeatAt = now()
    return { heartbeatAt, visibility: nextVisibility === 'visible' ? 'visible' : 'hidden' }
  }

  /** A live client owns banners and sound; the host backs off while it is fresh. */
  function alive() {
    return clientAlive(heartbeatAt, now())
  }

  async function dispatch(event, source) {
    const current = await loadPrefs()
    if (!eventEnabled(current, event.kind)) {
      return { accepted: false, native: false, reason: 'disabled' }
    }
    if (source === 'backup' && alive()) {
      return { accepted: false, native: false, reason: 'client-alive' }
    }
    if (event.key === undefined) throw new Error('attention events must carry a unique key')
    const key = event.key
    if (!shouldAccept(seenAt, key, now())) {
      return { accepted: false, native: false, reason: 'deduped', key }
    }
    if (current.native === false) {
      return { accepted: true, native: false, reason: 'native-disabled', key }
    }
    const result = await notify({
      title: event.title ?? 'DeepSeek Harness',
      body: event.body ?? localizeKind(event.kind, 'en'),
      kind: event.kind,
      sessionId: event.sessionId,
      sound: event.sound !== false && current.sound !== false,
    })
    if (!result.ok) {
      nativeAvailable = false
      log(`attention native notify failed: ${result.reason ?? 'unknown'}`)
      return { accepted: true, native: false, reason: result.reason ?? 'unavailable', key }
    }
    nativeAvailable = true
    return { accepted: true, native: true, key }
  }

  async function handle(endpoint, payload) {
    await loadPrefs()
    if (endpoint === 'prefs.get') {
      return success({ prefs, nativeAvailable })
    }
    if (endpoint === 'prefs.set') {
      const input = requireObject(payload)
      return success({ prefs: await savePrefs(input.prefs ?? input), nativeAvailable })
    }
    if (endpoint === 'visibility') {
      const input = requireObject(payload)
      const next = input.visibility === 'visible' ? 'visible' : 'hidden'
      return success(markVisibility(next))
    }
    if (endpoint === 'notify') {
      const input = requireObject(payload)
      const kind = requireString(input.kind, 'kind', 32)
      const sessionId = requireString(input.sessionId, 'sessionId')
      const key = requireString(input.key, 'key', 256)
      if (!['approval', 'plan-review', 'question', 'completed'].includes(kind)) {
        throw new Error('kind is not a supported attention event')
      }
      const result = await dispatch({
        kind,
        sessionId,
        key,
        title: typeof input.title === 'string' ? input.title : undefined,
        body: typeof input.body === 'string' ? input.body : undefined,
        sound: input.sound !== false && input.sound !== 'false',
      }, 'client')
      return success({ ...result, nativeAvailable })
    }
    return failure(`unknown attention endpoint: ${endpoint}`, 'not-found')
  }

  async function onApprovalRequest(req, next) {
    try {
      const sessionId = req?.agent?.id ?? req?.sessionId
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        const toolName = typeof req.toolName === 'string' ? req.toolName : 'tool'
        const identity = [req?.id, req?.callId].filter(Boolean).join(':')
        await dispatch({
          kind: 'approval',
          sessionId,
          title: 'DeepSeek Harness',
          body: `${localizeKind('approval', 'en')}: ${toolName}`,
          key: `approval:${sessionId}:${identity || 'unidentified'}`,
        }, 'backup')
      }
    } catch (error) {
      log(`attention approval listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  }

  async function onAgentStatus({ agent, status }) {
    try {
      const sessionId = agent?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const previous = prevStatus.get(sessionId)
      prevStatus.set(sessionId, status)
      if (!(previous === 'running' && status === 'idle')) return
      const seq = (completionSeq.get(sessionId) ?? 0) + 1
      completionSeq.set(sessionId, seq)
      await dispatch({
        kind: 'completed',
        sessionId,
        title: 'DeepSeek Harness',
        body: localizeKind('completed', 'en'),
        key: `completed:${sessionId}:${seq}`,
      }, 'backup')
    } catch (error) {
      log(`attention status listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    handle,
    onApprovalRequest,
    onAgentStatus,
    markVisibility,
    alive,
    getPrefs: () => prefs,
    getNativeAvailable: () => nativeAvailable,
  }
}

export function apply(ctx) {
  const host = createAttentionHost({
    log: (message) => ctx.logger?.warn?.(message),
  })

  ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
    try {
      return await host.handle(endpoint, payload)
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'attention request failed')
    }
  }, { authority: 'loopback' })

  if (typeof ctx.on === 'function') {
    ctx.on('approval/request', (req, next) => host.onApprovalRequest(req, next))
    ctx.on('agent/status', (payload) => {
      void host.onAgentStatus(payload)
    })
  }
}
