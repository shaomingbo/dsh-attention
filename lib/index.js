/**
 * Host half of dsh-attention: loopback RPC, preference file, native OS
 * notifications, and fail-open listeners on approval/status events.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  DEDUPE_MS,
  SOFT_DEDUPE_MS,
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
  /** Host-minted ordinals for completions and waterfall approvals. */
  const kindSeq = new Map()
  /** Delivery ledger: canonical key → { at, banner, soft? }. */
  const delivered = new Map()
  /** In-flight singleflight: one native send per key, concurrent reports share. */
  const inflight = new Map()
  /**
   * Occupied waits (question / plan-review): open mints an ordinal, close
   * releases it. A second tab reporting the same live wait collapses.
   */
  const liveWaits = new Map()
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

  function emptyVerdict(reason, extra = {}) {
    return { accepted: false, native: false, reason, banner: false, sound: false, fallback: false, ...extra }
  }

  function freshEntry(entry, at) {
    if (entry === undefined) return false
    const window = entry.soft === true ? SOFT_DEDUPE_MS : DEDUPE_MS
    return at - entry.at < window
  }

  async function dispatch(event, source) {
    const current = await loadPrefs()
    if (!eventEnabled(current, event.kind)) {
      return emptyVerdict('disabled')
    }
    if (source === 'backup' && alive()) {
      return emptyVerdict('client-alive')
    }
    if (event.key === undefined) throw new Error('attention events must carry a unique key')
    const key = event.minted === true ? event.key : canonicalKey(event.kind, event.sessionId)
    const at = now()
    const prior = delivered.get(key)
    if (freshEntry(prior, at)) {
      return emptyVerdict('deduped', { banner: prior.banner === true, key })
    }
    const pending = inflight.get(key)
    if (pending !== undefined) {
      const outcome = await pending.catch(() => undefined)
      return emptyVerdict('deduped', { banner: outcome?.banner === true, key })
    }
    const task = perform(key, event, current, source).finally(() => inflight.delete(key))
    inflight.set(key, task)
    return task
  }

  async function perform(key, event, current, source) {
    if (current.native === false) {
      if (source === 'backup') return emptyVerdict('native-unavailable-host', { key })
      delivered.set(key, { at: now(), banner: true })
      return { accepted: true, native: false, reason: 'native-disabled', banner: true, sound: true, fallback: true, key }
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
      if (source === 'backup') {
        // Backup has no browser. Leave the event unclaimed so the first
        // recovering tab can take sound + fallback instead of being told a
        // banner already exists.
        return {
          accepted: true, native: false, reason: result.reason ?? 'unavailable',
          banner: false, sound: false, fallback: false, key,
        }
      }
      delivered.set(key, { at: now(), banner: true, soft: true })
      return {
        accepted: true, native: false, reason: result.reason ?? 'unavailable',
        banner: false, sound: true, fallback: true, key,
      }
    }
    nativeAvailable = true
    delivered.set(key, { at: now(), banner: true })
    return {
      accepted: true, native: true, banner: true,
      sound: source !== 'backup', fallback: false, key,
    }
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
      const phase = input.phase === 'close' ? 'close' : 'open'
      if (phase === 'close') {
        if (kind === 'question' || kind === 'plan-review') {
          liveWaits.delete(`${kind}:${sessionId}`)
        }
        return success({
          accepted: false, native: false, reason: 'closed',
          banner: false, sound: false, fallback: false, nativeAvailable,
        })
      }
      // Completions and waterfall approvals collapse onto the host's current
      // ordinal (never advanced by a tab report). Questions / plan-reviews
      // occupy a live slot: the first open mints, later opens collapse,
      // close releases so the next real wait can mint again.
      let dispatchKey = key
      if (kind === 'completed' || kind === 'approval') {
        dispatchKey = canonicalKey(kind, sessionId)
      } else if (kind === 'question' || kind === 'plan-review') {
        const liveKey = `${kind}:${sessionId}`
        const occupied = liveWaits.get(liveKey)
        if (occupied !== undefined) {
          dispatchKey = `${kind}:${sessionId}:${occupied}`
        } else {
          dispatchKey = advanceKey(kind, sessionId)
          liveWaits.set(liveKey, kindSeq.get(liveKey))
        }
      }
      const result = await dispatch({
        kind,
        sessionId,
        key: dispatchKey,
        minted: true,
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
