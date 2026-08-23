/** Shared attention-state derivation. Host tests import this; the browser bundle inlines a twin. */

export const DEDUPE_MS = 30_000
export const HEARTBEAT_STALE_MS = 8_000

export const KIND_META = {
  approval: {
    priority: 0,
    prefix: { zh: '⚠ 待审批', en: '⚠ Approval' },
    title: { zh: '等待审批', en: 'Waiting for approval' },
  },
  'plan-review': {
    priority: 1,
    prefix: { zh: '⚠ 待审阅', en: '⚠ Review' },
    title: { zh: '计划待审', en: 'Plan awaiting review' },
  },
  question: {
    priority: 2,
    prefix: { zh: '❓ 待回答', en: '❓ Question' },
    title: { zh: '等待回答', en: 'Waiting for an answer' },
  },
  completed: {
    priority: 3,
    prefix: { zh: '✓ 已完成', en: '✓ Done' },
    title: { zh: '任务已完成', en: 'Task completed' },
  },
}

export const TITLE_PREFIXES = Object.values(KIND_META).flatMap((meta) => [meta.prefix.zh, meta.prefix.en])

export function defaultPrefs() {
  return {
    enabled: true,
    title: true,
    sound: true,
    native: true,
    browserNotification: true,
    events: {
      approval: true,
      question: true,
      completed: true,
    },
    permissionAsked: false,
  }
}

export function mergePrefs(raw) {
  const defaults = defaultPrefs()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaults
  const events = raw.events !== null && typeof raw.events === 'object' ? raw.events : {}
  return {
    enabled: raw.enabled !== false,
    title: raw.title !== false,
    sound: raw.sound !== false,
    native: raw.native !== false,
    browserNotification: raw.browserNotification !== false,
    events: {
      approval: events.approval !== false,
      question: events.question !== false,
      completed: events.completed !== false,
    },
    permissionAsked: raw.permissionAsked === true,
  }
}

export function eventEnabled(prefs, kind) {
  if (!prefs.enabled) return false
  if (kind === 'approval') return prefs.events.approval !== false
  if (kind === 'plan-review' || kind === 'question') return prefs.events.question !== false
  if (kind === 'completed') return prefs.events.completed !== false
  return false
}

export function attentionKey(kind, sessionId) {
  return `${kind}:${sessionId}`
}

/**
 * Pick the highest-priority live attention item from session list rows.
 * @param {readonly { id: string, displayTitle?: string, pendingInteraction?: string, completed?: boolean, running?: boolean }[]} rows
 * @param {string | undefined} currentId
 * @param {ReturnType<typeof defaultPrefs>} prefs
 * @param {{ selectedJustIdle?: boolean }} [extras]
 */
export function deriveAttention(rows, currentId, prefs, extras = {}) {
  let best = null
  for (const row of rows) {
    const finishedAway = row.completed === true && row.id !== currentId
    const finishedSelected = extras.selectedJustIdle === true && row.id === currentId && row.running !== true
    const kind = row.pendingInteraction ?? (finishedAway || finishedSelected ? 'completed' : null)
    if (kind === null || KIND_META[kind] === undefined || !eventEnabled(prefs, kind)) continue
    const candidate = {
      kind,
      sessionId: row.id,
      displayTitle: typeof row.displayTitle === 'string' && row.displayTitle.length > 0 ? row.displayTitle : row.id,
      key: attentionKey(kind, row.id),
      priority: KIND_META[kind].priority,
    }
    if (best === null || candidate.priority < best.priority) best = candidate
  }
  return best
}

export function pageIsAttentive(visibilityState, hasFocus) {
  return visibilityState === 'visible' && hasFocus === true
}

/** Completed is a one-shot ping; only blocking waits should own the tab title. */
export function holdsTabAttention(kind) {
  return kind === 'approval' || kind === 'plan-review' || kind === 'question'
}

export function stripTitlePrefix(title) {
  if (typeof title !== 'string') return ''
  for (const prefix of TITLE_PREFIXES) {
    const head = `${prefix} · `
    if (title.startsWith(head)) return title.slice(head.length)
    if (title === prefix) return ''
  }
  return title
}

export function applyTitlePrefix(title, kind, locale) {
  const meta = KIND_META[kind]
  if (meta === undefined) return title
  const lang = locale === 'zh' ? 'zh' : 'en'
  const base = stripTitlePrefix(title)
  return base.length === 0 ? meta.prefix[lang] : `${meta.prefix[lang]} · ${base}`
}

export function localizeKind(kind, locale) {
  const meta = KIND_META[kind]
  if (meta === undefined) return kind
  return meta.title[locale === 'zh' ? 'zh' : 'en']
}

export function shouldAccept(seenAt, key, now, windowMs = DEDUPE_MS) {
  const previous = seenAt.get(key)
  if (previous !== undefined && now - previous < windowMs) return false
  seenAt.set(key, now)
  return true
}

/**
 * A fresh heartbeat means a live client — regardless of tab visibility. A
 * live client owns banners and sound; the host backup fires only when the
 * heartbeat goes stale (tab frozen, window closed, page navigated away).
 */
export function clientAlive(heartbeatAt, now, staleMs = HEARTBEAT_STALE_MS) {
  if (typeof heartbeatAt !== 'number') return false
  return now - heartbeatAt <= staleMs
}
