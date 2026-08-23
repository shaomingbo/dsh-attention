# dsh-attention

Desktop attention alerts for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web.

The bundle tells you when a session finishes a turn (always — even the one you are reading) and when an agent is waiting for approval, a question, or a plan review (while the page is in the background). It is a GitHub-distributed DSH bundle, not a shell modification.

## What it does

| Event | When it alerts |
|---|---|
| Task finished (any session, including the one you are reading) | Always: sound + tab title flash + system banner |
| Approval / plan review / question | While this page is in the background or unfocused |

Each channel is independent and can be toggled in **Settings → Alerts**:

| Channel | Owner |
|---|---|
| Short chime (Web Audio, OpenCode/Codex-style) | The page, whenever it is open |
| Tab title prefix + favicon badge | The page (blocking waits hold it; finished flashes ~4 s) |
| Native OS banner (`osascript` / `notify-send` / Windows toast) | The host |

**Single-producer rule:** while a browser tab is alive (heartbeat fresher than ~8 s), the page owns the banner and the chime; the host backs off. If every tab is closed or frozen, the host fires the banner itself (with the bundled chime) — no duplicates, no gaps. The host is also the sole identity minter for completions and approvals: every report of the same edge — backup listener, first tab, second tab — resolves to one per-session ordinal, so concurrent tabs collapse to a single banner (and only the accepted producer owns the chime), while a genuinely new edge always gets a fresh identity. Completion edges observed while preferences are still loading are stashed and flushed once loaded, so a startup race cannot swallow a notification.

When the native notifier binary is missing (`notify-send` absent, and so on), the host reports it, the Alerts page shows native notifications as unavailable, and the browser `Notification` fallback takes over automatically.

## Install

```bash
dsh plugin --profile web add github:shaomingbo/dsh-attention#v0.1.0
```

Or run the package installer:

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.0
```

Restart `dsh web`, then hard-refresh the browser. To update:

```bash
dsh plugin --profile web update dsh-attention
```

To remove it:

```bash
dsh plugin --profile web remove dsh-attention
```

For a local checkout:

```bash
npx --yes /path/to/dsh-attention --source link:/path/to/dsh-attention
```

## Settings

Open **Settings → Alerts** to toggle:

- Master enable
- Tab title / favicon
- Sound
- Native desktop notification
- Browser notification fallback
- Event classes: approvals, questions/plan reviews, finished tasks

Preferences live in `$DSH_HOME/attention.json` (default `~/.dsh/attention.json`) so they survive a browser refresh.

## Behaviour notes

- Finished turns alert unconditionally — watching the page included. Approvals and questions stay quiet while you are looking at the page.
- Native notifications are loopback-only. A remote Web GUI cannot trigger them.
- The host listens to `approval/request` but always calls `next()`. It never answers an approval.
- The first visit may show a toast asking for browser notification permission. That permission is only used as a fallback when native notifications are unavailable.

## Development

```bash
npm test
npm run check
```

`lib/` is the release authority. The browser half is a hand-written `window.__ModuleLoader__` bundle, matching other optional DSH Web plugins.

## License

MIT.
