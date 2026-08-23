/**
 * Host half of dsh-attention: loopback RPC, preference file, native OS
 * notifications, and fail-open listeners on approval/status events.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  DEDUPE_MS,
  clientAlive,
  defaultPrefs,
  eventEnabled,
  localizeKind,
  mergePrefs,
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
  /** Canonical identity per (kind, session): minted only by the host. */
  const kindSeq = new Map()
  /** Delivery ledger: canonical key → when it fired and whether a banner went out. */
  const delivered = new Map()
  /** Last client-reported waiting key per (kind, session), for ordinal mapping. */
  const waitingReports = new Map()
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

  /**
   * Identity minting over {@link kindSeq}: canonicalKey reads the current
   * ordinal (same edge, every producer), advanceKey mints the next one.
   */
  function canonicalKey(kind, sessionId) {
    const scoped = kindSeq.get(`${kind}:${sessionId}`) || 1
    return `${kind}:${sessionId}:${scoped}`
  }

  function advanceKey(kind, sessionId) {
    const mapKey = `${kind}:${sessionId}`
    const next = (kindSeq.get(mapKey) ?? 0) + 1
    kindSeq.set(mapKey, next)
    return `${kind}:${sessionId}:${next}`
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
    const key = event.minted === true ? event.key : canonicalKey(event.kind, event.sessionId)
    const previous = delivered.get(key)
    if (previous !== undefined && now() - previous.at < DEDUPE_MS) {
      // `delivered` records whether a banner ACTUALLY went out for this key;
      // a deduped echo tells the client exactly that, nothing more.
      return { accepted: false, native: false, reason: 'deduped', banner: previous.banner, key }
    }
    if (current.native === false) {
      delivered.set(key, { at: now(), banner: false })
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
      // Nothing was delivered: the next report of this key must retry the
      // fallback instead of being told a banner already exists.
      return { accepted: true, native: false, reason: result.reason ?? 'unavailable', key }
    }
    nativeAvailable = true
    delivered.set(key, { at: now(), banner: true })
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
      // Waiting kinds (approval/question/plan-review) arrive from tabs that
      // cannot know the edge ordinal. Map the reported key to the host's
      // current ordinal: a re-report of a wait this host already delivered
      // collapses (client-supplied key seen recently), while a different key
      // means a genuinely new wait and advances the ordinal.
      let dispatchKey = key
      let minted = false
      if (kind !== 'completed') {
        const reported = waitingReports.get(`${kind}:${sessionId}`)
        if (reported !== undefined && reported.clientKey === key && now() - reported.at < DEDUPE_MS) {
          dispatchKey = reported.hostKey
        } else {
          dispatchKey = advanceWaitingKey(kind, sessionId)
          waitingReports.set(`${kind}:${sessionId}`, { at: now(), clientKey: key, hostKey: dispatchKey })
        }
        minted = true
      }
      const result = await dispatch({
        kind,
        sessionId,
        key: dispatchKey,
        minted,
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
        // Every waterfall entry is one distinct live ask: mint its ordinal
        // before dispatch so `callId`-less asks never share an identity.
        const key = advanceKey('approval', sessionId)
        await dispatch({
          kind: 'approval',
          sessionId,
          title: 'DeepSeek Harness',
          body: `${localizeKind('approval', 'en')}: ${toolName}`,
          key,
          minted: true,
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
      await dispatch({
        kind: 'completed',
        sessionId,
        title: 'DeepSeek Harness',
        body: localizeKind('completed', 'en'),
        key: advanceKey('completed', sessionId),
        minted: true,
      }, 'backup')
    } catch (error) {
      log(`attention status listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function advanceWaitingKey(kind, sessionId) {
    return advanceKey(kind, sessionId)
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
    // Prepend the approval listener: the API Gateway answers live approval
    // requests without calling later waterfall entries, so an appended
    // observer would never run and its ordinal would never advance.
    ctx.on('approval/request', (req, next) => host.onApprovalRequest(req, next), true)
    ctx.on('agent/status', (payload) => {
      void host.onAgentStatus(payload)
    })
  }
}
