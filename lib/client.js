/**
 * Browser half of dsh-attention: watches the session list, updates the tab
 * title and favicon, plays a short chime, and asks the host to fire a native
 * OS notification when the page is not in front.
 */

window.__ModuleLoader__.load({
  id: 'dsh-attention',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const CHANNEL = '/attention'
    const NS = 'dsh-attention'
    const HEARTBEAT_MS = 4000

    const KIND_META = {
      approval: {
        priority: 0,
        prefix: { zh: '⚠ 待审批', en: '⚠ Approval' },
        title: { zh: '等待审批', en: 'Waiting for approval' },
        color: '#d97706',
      },
      'plan-review': {
        priority: 1,
        prefix: { zh: '⚠ 待审阅', en: '⚠ Review' },
        title: { zh: '计划待审', en: 'Plan awaiting review' },
        color: '#d97706',
      },
      question: {
        priority: 2,
        prefix: { zh: '❓ 待回答', en: '❓ Question' },
        title: { zh: '等待回答', en: 'Waiting for an answer' },
        color: '#2563eb',
      },
      completed: {
        priority: 3,
        prefix: { zh: '✓ 已完成', en: '✓ Done' },
        title: { zh: '任务已完成', en: 'Task completed' },
        color: '#16a34a',
      },
    }
    const TITLE_PREFIXES = Object.values(KIND_META).flatMap((meta) => [meta.prefix.zh, meta.prefix.en])

    const en = {
      nav: 'Alerts',
      title: 'Attention alerts',
      intro: 'Finished turns always alert (sound, tab title, system banner). Approvals and questions alert while this page is in the background. Each channel can be toggled below.',
      master: 'Enable attention alerts',
      titleToggle: 'Flash the tab title and favicon',
      soundToggle: 'Play a short sound',
      nativeToggle: 'Native desktop notification',
      browserToggle: 'Browser notification fallback',
      eventsTitle: 'Notify me about',
      eventApproval: 'Tool approvals',
      eventQuestion: 'Questions and plan reviews',
      eventCompleted: 'Finished tasks',
      nativeAvailable: 'Native notifications are available on this computer.',
      nativeUnavailable: 'Native notifications are unavailable. Browser notifications will be used as a fallback.',
      grant: 'Allow browser notifications',
      granted: 'Browser notifications allowed',
      denied: 'Browser notifications are blocked in this browser.',
      toastTitle: 'DSH is running in the background',
      toastBody: 'Allow notifications so approvals and finished tasks can reach you when this tab is hidden.',
      toastGrant: 'Allow',
      toastLater: 'Later',
      saveFailed: 'Could not save alert preferences.',
    }

    const zh = {
      nav: '提醒',
      title: '注意力提醒',
      intro: '任务完成时总会提醒（声音、标签标题、系统横幅）；审批与提问在页面不在前台时提醒。各通道可在下方分别开关。',
      master: '启用注意力提醒',
      titleToggle: '闪烁标签标题和 favicon 红点',
      soundToggle: '播放短提示音',
      nativeToggle: '系统原生通知',
      browserToggle: '浏览器通知回退',
      eventsTitle: '提醒这些事件',
      eventApproval: '工具审批',
      eventQuestion: '提问和计划审阅',
      eventCompleted: '任务完成',
      nativeAvailable: '这台电脑可以使用系统通知。',
      nativeUnavailable: '系统通知不可用，将回退到浏览器通知。',
      grant: '允许浏览器通知',
      granted: '已允许浏览器通知',
      denied: '此浏览器已拦截通知。',
      toastTitle: 'DSH 正在后台运行',
      toastBody: '允许通知后，审批和任务完成可以在标签隐藏时提醒你。',
      toastGrant: '允许',
      toastLater: '稍后',
      saveFailed: '无法保存提醒偏好。',
    }

    function defaultPrefs() {
      return {
        enabled: true,
        title: true,
        sound: true,
        native: true,
        browserNotification: true,
        events: { approval: true, question: true, completed: true },
        permissionAsked: false,
      }
    }

    function mergePrefs(raw) {
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

    function eventEnabled(prefs, kind) {
      if (!prefs.enabled) return false
      if (kind === 'approval') return prefs.events.approval !== false
      if (kind === 'plan-review' || kind === 'question') return prefs.events.question !== false
      if (kind === 'completed') return prefs.events.completed !== false
      return false
    }

    function deriveAttention(rows, currentId, prefs) {
      let best = null
      for (const row of rows) {
        const kind = row.pendingInteraction
          ?? (row.completed === true && row.id !== currentId ? 'completed' : null)
        if (kind === null || KIND_META[kind] === undefined || !eventEnabled(prefs, kind)) continue
        const candidate = {
          kind,
          sessionId: row.id,
          displayTitle: typeof row.displayTitle === 'string' && row.displayTitle.length > 0 ? row.displayTitle : row.id,
          key: `${kind}:${row.id}`,
          priority: KIND_META[kind].priority,
        }
        if (best === null || candidate.priority < best.priority) best = candidate
      }
      return best
    }

    function pageIsAttentive() {
      return document.visibilityState === 'visible' && document.hasFocus()
    }

    function holdsTabAttention(kind) {
      return kind === 'approval' || kind === 'plan-review' || kind === 'question'
    }

    function stripTitlePrefix(title) {
      if (typeof title !== 'string') return ''
      for (const prefix of TITLE_PREFIXES) {
        const head = `${prefix} · `
        if (title.startsWith(head)) return title.slice(head.length)
        if (title === prefix) return ''
      }
      return title
    }

    function resolveLocale(locale) {
      try {
        const current = locale?.get?.()
        if (typeof current === 'string' && current.startsWith('zh')) return 'zh'
      } catch {
        // locale service is optional
      }
      const lang = typeof document.documentElement.lang === 'string' ? document.documentElement.lang : ''
      return lang.startsWith('zh') ? 'zh' : 'en'
    }

    function fallbackT(key) {
      return en[key] ?? key
    }

    function useT(locale) {
      if (locale !== undefined && typeof locale.bind === 'function') return locale.bind(NS)
      const dict = resolveLocale(locale) === 'zh' ? zh : en
      return (key) => dict[key] ?? en[key] ?? key
    }

    function createStore() {
      let state = {
        prefs: defaultPrefs(),
        nativeAvailable: true,
        loaded: false,
        toast: false,
        error: null,
      }
      const listeners = new Set()
      const emit = () => listeners.forEach((listener) => listener())
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        update(patch) {
          state = { ...state, ...patch }
          emit()
        },
      }
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    async function rpc(connection, endpoint, payload = {}) {
      const result = await connection.rpc.call(CHANNEL, endpoint, payload)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }

    const chrome = {
      prefixKind: null,
      originalIcon: null,
      iconLink: null,
      titleObserver: null,
      audio: null,
    }

    function ensureTitleObserver() {
      if (chrome.titleObserver !== null) return
      const target = document.querySelector('title') ?? document.head
      chrome.titleObserver = new MutationObserver(() => {
        if (chrome.prefixKind === null) return
        const locale = document.documentElement.lang?.startsWith('zh') ? 'zh' : 'en'
        const wanted = applyPrefixedTitle(document.title, chrome.prefixKind, locale)
        if (document.title !== wanted) document.title = wanted
      })
      chrome.titleObserver.observe(target, { childList: true, characterData: true, subtree: true })
    }

    function applyPrefixedTitle(title, kind, locale) {
      const meta = KIND_META[kind]
      if (meta === undefined) return title
      const base = stripTitlePrefix(title)
      return base.length === 0 ? meta.prefix[locale] : `${meta.prefix[locale]} · ${base}`
    }

    function setTitleAttention(kind, locale) {
      chrome.prefixKind = kind
      ensureTitleObserver()
      document.title = applyPrefixedTitle(document.title, kind, locale)
    }

    function clearTitleAttention() {
      if (chrome.prefixKind === null) return
      document.title = stripTitlePrefix(document.title)
      chrome.prefixKind = null
    }

    function ensureIconLink() {
      if (chrome.iconLink !== null) return chrome.iconLink
      const existing = document.querySelector("link[rel='icon']")
      if (existing instanceof HTMLLinkElement) {
        chrome.iconLink = existing
        chrome.originalIcon = existing.href
        return existing
      }
      const created = document.createElement('link')
      created.rel = 'icon'
      document.head.append(created)
      chrome.iconLink = created
      chrome.originalIcon = ''
      return created
    }

    function paintFavicon(color) {
      const link = ensureIconLink()
      const canvas = document.createElement('canvas')
      canvas.width = 32
      canvas.height = 32
      const ctx = canvas.getContext('2d')
      if (ctx === null) return
      const finish = () => {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(24, 8, 7, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 2
        ctx.stroke()
        link.href = canvas.toDataURL('image/png')
      }
      if (chrome.originalIcon) {
        const image = new Image()
        image.onload = () => {
          ctx.clearRect(0, 0, 32, 32)
          ctx.drawImage(image, 0, 0, 32, 32)
          finish()
        }
        image.onerror = () => {
          ctx.fillStyle = '#111827'
          ctx.fillRect(0, 0, 32, 32)
          finish()
        }
        image.src = chrome.originalIcon
        return
      }
      ctx.fillStyle = '#111827'
      ctx.fillRect(0, 0, 32, 32)
      finish()
    }

    function clearFavicon() {
      if (chrome.iconLink === null) return
      if (chrome.originalIcon) chrome.iconLink.href = chrome.originalIcon
    }

    function unlockAudio() {
      if (chrome.audio !== null) {
        if (chrome.audio.state === 'suspended') void chrome.audio.resume()
        return chrome.audio
      }
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (typeof Ctx !== 'function') return null
      chrome.audio = new Ctx()
      return chrome.audio
    }

    function playTone(kind) {
      const audio = unlockAudio()
      if (audio === null) return
      const now = audio.currentTime
      const notes = kind === 'completed'
        ? [{ freq: 659, at: 0, dur: 0.14 }, { freq: 784, at: 0.09, dur: 0.16 }, { freq: 988, at: 0.2, dur: 0.32 }]
        : [{ freq: 784, at: 0, dur: 0.18 }, { freq: 1175, at: 0.12, dur: 0.28 }]
      for (const note of notes) {
        const osc = audio.createOscillator()
        const harmonic = audio.createOscillator()
        const gain = audio.createGain()
        const start = now + note.at
        osc.frequency.value = note.freq
        harmonic.frequency.value = note.freq * 2
        osc.type = 'sine'
        harmonic.type = 'sine'
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.dur)
        osc.connect(gain)
        harmonic.connect(gain)
        gain.connect(audio.destination)
        osc.start(start)
        harmonic.start(start)
        osc.stop(start + note.dur)
        harmonic.stop(start + note.dur)
      }
    }

    function showBrowserNotification(attention, locale, sessions) {
      if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
      const meta = KIND_META[attention.kind]
      const notification = new Notification(meta.title[locale], {
        body: attention.displayTitle,
        tag: attention.key,
      })
      notification.onclick = () => {
        window.focus()
        sessions?.open?.(attention.sessionId)
        notification.close()
      }
    }

    function selectRows(state) {
      const rows = []
      for (const id of state.ids ?? []) {
        const session = state.byId?.[id]
        if (session === undefined) continue
        rows.push({
          id,
          displayTitle: session.displayTitle,
          pendingInteraction: session.pendingInteraction,
          completed: session.completed === true,
          running: session.running === true,
        })
      }
      return { current: state.current, rows }
    }

    function AttentionRoot(props) {
      const store = props.store
      const state = useStore(store)
      const localeName = resolveLocale(props.locale)
      const t = useT(props.locale)
      const snapshot = typeof props.useSessions === 'function'
        ? props.useSessions(selectRows)
        : { current: undefined, rows: [] }
      const lastKey = React.useRef(null)
      const flashTimer = React.useRef(null)
      const prevRunning = React.useRef(new Map())
      const blockingKind = React.useRef(null)
      const selected = snapshot.rows.find((row) => row.id === snapshot.current)
      const attention = deriveAttention(snapshot.rows, snapshot.current, state.prefs)
      blockingKind.current = attention !== null && holdsTabAttention(attention.kind) ? attention.kind : null
      React.useEffect(() => {
        window.__DSH_ATTENTION_DEBUG = {
          hasUseSessions: typeof props.useSessions,
          current: snapshot.current,
          running: selected?.running === true,
          attentive: pageIsAttentive(),
          visibility: document.visibilityState,
          rowCount: snapshot.rows.length,
          lastKey: lastKey.current,
          blockingKind: blockingKind.current,
          prefs: state.prefs,
        }
      })

      const syncHeartbeat = React.useCallback((visibility) => {
        void rpc(props.connection, 'visibility', { visibility }).catch(() => {})
      }, [props.connection])

      React.useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const value = await rpc(props.connection, 'prefs.get')
            if (cancelled) return
            const prefs = mergePrefs(value.prefs)
            store.update({
              prefs,
              nativeAvailable: value.nativeAvailable !== false,
              loaded: true,
              toast: prefs.permissionAsked !== true
                && typeof Notification === 'function'
                && Notification.permission === 'default',
            })
          } catch {
            if (!cancelled) store.update({ loaded: true })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [props.connection, store])

      const notifyHost = React.useCallback(async (kind, sessionId, displayTitle, key) => {
        const result = await rpc(props.connection, 'notify', {
          kind,
          sessionId,
          title: KIND_META[kind].title[localeName],
          body: displayTitle,
          key,
          sound: false,
        })
        store.update({ nativeAvailable: result.nativeAvailable !== false })
        // The banner is handled when the host showed it natively or when this
        // exact event was already delivered (a live client is the sole banner
        // producer, so a deduped echo still means a banner exists).
        return result.native === true || result.reason === 'deduped'
      }, [localeName, props.connection, store])

      const flashCompletedTitle = React.useCallback(() => {
        if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
        flashTimer.current = window.setTimeout(() => {
          flashTimer.current = null
          if (blockingKind.current === null) {
            clearTitleAttention()
            clearFavicon()
          }
        }, 4000)
      }, [])

      const fireCompleted = React.useCallback((sessionId, displayTitle) => {
        if (!state.loaded || !state.prefs.enabled || !eventEnabled(state.prefs, 'completed')) return
        // Bucket the completion into a 30 s window: two tabs reporting the
        // same running→idle edge land in one bucket (one banner), while a
        // later genuine completion gets a fresh bucket and still rings.
        const bucket = Math.floor(Date.now() / 30_000)
        const key = `completed:${sessionId}:${bucket}`
        if (state.prefs.title) {
          setTitleAttention('completed', localeName)
          paintFavicon(KIND_META.completed.color)
          flashCompletedTitle()
        }
        void (async () => {
          let bannerHandled = false
          try {
            bannerHandled = await notifyHost('completed', sessionId, displayTitle, key)
          } catch {
            bannerHandled = false
          }
          if (state.prefs.sound) playTone('completed')
          if (!bannerHandled && state.prefs.browserNotification) {
            showBrowserNotification({
              kind: 'completed',
              sessionId,
              displayTitle,
              key,
            }, localeName, props.sessions)
          }
        })()
      }, [flashCompletedTitle, localeName, notifyHost, props.sessions, state.loaded, state.prefs])

      React.useEffect(() => {
        const report = () => syncHeartbeat(pageIsAttentive() ? 'visible' : 'hidden')
        report()
        const timer = window.setInterval(report, HEARTBEAT_MS)
        document.addEventListener('visibilitychange', report)
        window.addEventListener('focus', report)
        window.addEventListener('blur', report)
        const unlock = () => unlockAudio()
        window.addEventListener('pointerdown', unlock, { once: true })
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', report)
          window.removeEventListener('focus', report)
          window.removeEventListener('blur', report)
          window.removeEventListener('pointerdown', unlock)
          clearTitleAttention()
          clearFavicon()
        }
      }, [syncHeartbeat])

      React.useEffect(() => {
        if (!state.loaded) return
        for (const row of snapshot.rows) {
          const previous = prevRunning.current.get(row.id)
          if (previous === true && row.running === false) {
            fireCompleted(row.id, row.displayTitle)
          }
          prevRunning.current.set(row.id, row.running === true)
        }
      }, [fireCompleted, snapshot, state.loaded])

      React.useEffect(() => {
        if (!state.loaded) return
        if (!state.prefs.enabled || attention === null || pageIsAttentive()) {
          // Nothing blocks the tab (or the plugin is off / user is looking):
          // release the title unless the one-shot completed flash owns it.
          if (flashTimer.current === null) {
            clearTitleAttention()
            clearFavicon()
            if (attention === null) lastKey.current = null
          }
          return
        }
        if (!holdsTabAttention(attention.kind)) return
        if (state.prefs.title) {
          setTitleAttention(attention.kind, localeName)
          paintFavicon(KIND_META[attention.kind].color)
        }
        if (lastKey.current === attention.key) return
        // Reset the fire identity whenever a NEW blocking wait appears, so
        // the same session's next approval rings again after this one clears.
        lastKey.current = attention.key
        // Waiting events ring in the same 30 s bucket as the dedupe window:
        // concurrent tabs collapse to one banner, a later wait gets a new key.
        const key = `${attention.key}:${Math.floor(Date.now() / 30_000)}`
        void (async () => {
          let bannerHandled = false
          try {
            bannerHandled = await notifyHost(attention.kind, attention.sessionId, attention.displayTitle, key)
          } catch {
            bannerHandled = false
          }
          if (state.prefs.sound) playTone(attention.kind)
          if (!bannerHandled && state.prefs.browserNotification) {
            showBrowserNotification(attention, localeName, props.sessions)
          }
        })()
      }, [attention, localeName, notifyHost, props.sessions, state.loaded, state.prefs])

      if (!state.toast) return null
      return h('div', {
        role: 'status',
        style: toastStyle,
      }, [
        h('strong', { key: 'title', style: { display: 'block', marginBottom: 4 } }, t('toastTitle')),
        h('p', { key: 'body', style: { margin: '0 0 10px', fontSize: 13, lineHeight: 1.45 } }, t('toastBody')),
        h('div', { key: 'actions', style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, [
          h('button', {
            key: 'later',
            type: 'button',
            style: buttonStyle,
            onClick: () => {
              const prefs = { ...state.prefs, permissionAsked: true }
              store.update({ prefs, toast: false })
              void rpc(props.connection, 'prefs.set', { prefs }).catch(() => {})
            },
          }, t('toastLater')),
          h('button', {
            key: 'grant',
            type: 'button',
            style: { ...buttonStyle, background: '#2563eb', borderColor: '#2563eb', color: '#ffffff' },
            onClick: async () => {
              unlockAudio()
              if (typeof Notification === 'function' && Notification.permission === 'default') {
                await Notification.requestPermission()
              }
              const prefs = { ...state.prefs, permissionAsked: true }
              store.update({ prefs, toast: false })
              void rpc(props.connection, 'prefs.set', { prefs }).catch(() => {})
            },
          }, t('toastGrant')),
        ]),
      ])
    }

    function Toggle({ label, checked, disabled, onChange }) {
      return h('label', { style: toggleRowStyle }, [
        h('input', {
          key: 'input',
          type: 'checkbox',
          checked,
          disabled,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { key: 'label' }, label),
      ])
    }

    function Section(props) {
      const store = props.store
      const state = useStore(store)
      const t = useT(props.locale)
      const prefs = state.prefs
      const disabled = !prefs.enabled

      const save = async (next) => {
        const prefsNext = mergePrefs(next)
        store.update({ prefs: prefsNext, error: null })
        try {
          const value = await rpc(props.connection, 'prefs.set', { prefs: prefsNext })
          store.update({ prefs: mergePrefs(value.prefs), nativeAvailable: value.nativeAvailable !== false })
        } catch (cause) {
          store.update({ error: cause instanceof Error ? cause.message : t('saveFailed') })
        }
      }

      const permission = typeof Notification === 'function' ? Notification.permission : 'denied'

      return h('div', { style: sectionStyle }, [
        h('h2', { key: 'title' }, t('title')),
        h('p', { key: 'intro', style: secondaryStyle }, t('intro')),
        h(Toggle, {
          key: 'master',
          label: t('master'),
          checked: prefs.enabled,
          onChange: (enabled) => save({ ...prefs, enabled }),
        }),
        h(Toggle, {
          key: 'titleToggle',
          label: t('titleToggle'),
          checked: prefs.title,
          disabled,
          onChange: (title) => save({ ...prefs, title }),
        }),
        h(Toggle, {
          key: 'sound',
          label: t('soundToggle'),
          checked: prefs.sound,
          disabled,
          onChange: (sound) => save({ ...prefs, sound }),
        }),
        h(Toggle, {
          key: 'native',
          label: t('nativeToggle'),
          checked: prefs.native,
          disabled,
          onChange: (native) => save({ ...prefs, native }),
        }),
        h(Toggle, {
          key: 'browser',
          label: t('browserToggle'),
          checked: prefs.browserNotification,
          disabled,
          onChange: (browserNotification) => save({ ...prefs, browserNotification }),
        }),
        h('p', { key: 'nativeStatus', style: secondaryStyle },
          state.nativeAvailable ? t('nativeAvailable') : t('nativeUnavailable')),
        permission === 'default'
          ? h('button', {
            key: 'grant',
            type: 'button',
            style: buttonStyle,
            onClick: async () => {
              unlockAudio()
              if (typeof Notification === 'function') await Notification.requestPermission()
              await save({ ...prefs, permissionAsked: true })
            },
          }, t('grant'))
          : h('p', { key: 'perm', style: secondaryStyle }, permission === 'granted' ? t('granted') : t('denied')),
        h('h3', { key: 'eventsTitle' }, t('eventsTitle')),
        h(Toggle, {
          key: 'approval',
          label: t('eventApproval'),
          checked: prefs.events.approval,
          disabled,
          onChange: (approval) => save({ ...prefs, events: { ...prefs.events, approval } }),
        }),
        h(Toggle, {
          key: 'question',
          label: t('eventQuestion'),
          checked: prefs.events.question,
          disabled,
          onChange: (question) => save({ ...prefs, events: { ...prefs.events, question } }),
        }),
        h(Toggle, {
          key: 'completed',
          label: t('eventCompleted'),
          checked: prefs.events.completed,
          disabled,
          onChange: (completed) => save({ ...prefs, events: { ...prefs.events, completed } }),
        }),
        state.error ? h('p', { key: 'error', style: errorStyle }, state.error) : null,
      ])
    }

    const toastStyle = {
      pointerEvents: 'auto',
      position: 'fixed',
      right: 16,
      bottom: 16,
      zIndex: 80,
      width: 320,
      padding: 14,
      borderRadius: 12,
      border: '1px solid var(--dsw-alias-border-l2, #ffffff1f)',
      background: 'var(--dsw-alias-bg-layer-2, #2c2c2e)',
      color: 'var(--dsw-alias-label-primary, #f9fafb)',
      boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
    }
    const buttonStyle = {
      border: '1px solid var(--dsw-alias-border-l2, #ffffff1f)',
      borderRadius: 8,
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, #f9fafb)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 13,
      padding: '6px 10px',
    }
    const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }
    const secondaryStyle = { margin: 0, color: 'var(--dsw-alias-label-secondary, #cfd3d6)', fontSize: 13, lineHeight: 1.5 }
    const toggleRowStyle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }
    const errorStyle = { margin: 0, color: '#b42318', fontSize: 13 }

    function readLocale(ctx) {
      try {
        return ctx.locale
      } catch {
        return undefined
      }
    }

    function readSessions(ctx) {
      try {
        return ctx.sessions
      } catch {
        return undefined
      }
    }

    function registerCopy(locale) {
      try {
        return locale.register(NS, { zh, en })
      } catch (error) {
        if (!String(error?.message ?? error).includes('already has locale')) throw error
        return () => {}
      }
    }

    const inject = ['slots', 'connection']

    function apply(ctx) {
      const store = createStore()
      const locale = readLocale(ctx)
      const sessions = readSessions(ctx)
      if (locale !== undefined && typeof locale.register === 'function') {
        if (typeof ctx.effect === 'function') ctx.effect(() => registerCopy(locale), 'dsh-attention: copy dictionaries')
        else registerCopy(locale)
      }
      const t = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : fallbackT
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-attention:observer',
        order: 20,
      }, (props) => h(AttentionRoot, {
        useSessions: props.useSessions,
        connection: ctx.connection,
        sessions,
        store,
        locale,
      })))
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'attention',
        order: 14,
        label: () => t('nav'),
        inject: () => ({ store, connection: ctx.connection, locale }),
      }, (props) => h(Section, { ...props, store, connection: ctx.connection, locale })))
    }

    return { apply, inject }
  },
})
