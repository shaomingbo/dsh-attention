# dsh-attention

Desktop attention alerts for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web.

When the GUI tab is hidden or unfocused, the bundle tells you that an agent is waiting for approval / a question / a plan review, or that a background session finished. It is a GitHub-distributed DSH bundle, not a shell modification.

## What it does

| Channel | When it fires |
|---|---|
| Tab title prefix + favicon badge | Page is in the background and something needs you |
| Short Web Audio chime | Same edge, if sound is enabled |
| Native OS notification | Host-side banner (macOS `osascript`, Linux `notify-send`, Windows toast) |
| Browser `Notification` | Fallback only when native notify is unavailable |

The page does not beep or banner while you are looking at it. Opening a finished session clears the built-in green "completed" reminder; this plugin follows that same rule.

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

- Native notifications are loopback-only. A remote Web GUI cannot trigger them.
- The host listens to `approval/request` but always calls `next()`. It never answers an approval.
- Questions have no host-side backup if no browser client is connected. Approvals and completions still can, when the last visibility heartbeat is hidden or stale.
- The first visit may show a toast asking for browser notification permission. That permission is only used as a fallback.

## Development

```bash
npm test
npm run check
```

`lib/` is the release authority. The browser half is a hand-written `window.__ModuleLoader__` bundle, matching other optional DSH Web plugins.

## License

MIT.
