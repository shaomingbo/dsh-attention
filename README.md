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

**Single-producer rule:** while a browser tab is alive (heartbeat fresher than ~8 s), the page owns the banner and the chime; the host backs off. If every tab is closed or frozen, the host fires the banner itself (with the bundled chime) — no duplicates, no gaps. Completions and waterfall approvals collapse onto a host-minted per-session ordinal. Questions and plan reviews occupy a live slot: the first tab to report `open` mints the identity, later tabs collapse, and `close` (when the wait leaves the session list) releases the slot so the next real question can ring. Concurrent reports of one identity single-flight: the host grants `sound` and `fallback` to exactly one caller. A client-side native failure is soft-recorded so echoes collapse; a backup failure leaves the event unclaimed so the first recovering tab can fall back. Completion edges observed while preferences are still loading are stashed and flushed once loaded.

When the native notifier binary is missing (`notify-send` absent, and so on), the host reports it, the Alerts page shows native notifications as unavailable, and the browser `Notification` fallback takes over automatically.

## Install

Preferred — install the fixed release tag with the package's own no-argument installer:

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.3
```

No arguments is the same as `install`. The installer only edits `dependencies.dsh-attention` and `dsh.profile.bundles` in the target profile's `package.json` (default profile `web`), writes it atomically, then runs `pnpm install --ignore-scripts` in that profile directory. It never stops or restarts DSH.

Check installation state:

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.3 status
```

Remove it (idempotent — safe to run twice, restores the manifest if dependency installation fails):

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.3 uninstall
```

Options available to every command: `--profile <name>` (default `web`), `--source <source>`, `-h`/`--help`. The default source is pinned to the current SemVer tag; you can also point it at a local checkout with `link:`:

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.3 --source link:/path/to/dsh-attention
```

After installing or uninstalling: restart `dsh web` manually, then hard-refresh the browser.

Manual fallback — edit `~/.dsh/profiles/web/package.json` yourself:

```json
{
  "dependencies": {
    "dsh-attention": "github:shaomingbo/dsh-attention#v0.1.3"
  },
  "dsh": {
    "profile": { "bundles": ["dsh-attention"] }
  }
}
```

Then run `pnpm install --ignore-scripts` in that profile directory and restart DSH.

If you manage bundles through `dsh plugin` instead, the equivalents are `dsh plugin --profile web add|update|remove dsh-attention`.

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
