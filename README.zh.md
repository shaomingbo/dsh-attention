# dsh-attention

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 用的桌面注意力提醒。

当 GUI 标签隐藏或失焦时，插件会告诉你：agent 正在等审批 / 提问 / 计划审阅，或者某个后台会话已经跑完。它是可分发的 DSH bundle，不是对 shell 的修改。

## 做什么

| 通道 | 何时响 |
|---|---|
| 标签标题前缀 + favicon 红点 | 页面在后台，并且有事需要你 |
| 短促 Web Audio | 同一边沿，声音开启时 |
| 系统原生通知 | Host 侧横幅（macOS `osascript`、Linux `notify-send`、Windows toast） |
| 浏览器 `Notification` | 仅在原生通知不可用时回退 |

你正看着页面时不会响、不会弹。打开已完成会话会清掉侧栏绿点；本插件遵循同一规则。

## 安装

```bash
dsh plugin --profile web add github:shaomingbo/dsh-attention#v0.1.0
```

或运行包装安装器：

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.0
```

重启 `dsh web`，然后硬刷新浏览器。更新：

```bash
dsh plugin --profile web update dsh-attention
```

卸载：

```bash
dsh plugin --profile web remove dsh-attention
```

本地 checkout：

```bash
npx --yes /path/to/dsh-attention --source link:/path/to/dsh-attention
```

## 设置

打开 **设置 → 提醒** 可开关：

- 总开关
- 标签标题 / favicon
- 声音
- 系统原生通知
- 浏览器通知回退
- 事件类别：审批、提问/计划审阅、任务完成

偏好保存在 `$DSH_HOME/attention.json`（默认 `~/.dsh/attention.json`），刷新浏览器不会丢。

## 行为说明

- 原生通知仅限 loopback。远程 Web GUI 不能触发本机通知。
- Host 监听 `approval/request`，但一定会 `next()`，绝不代替你做审批决定。
- 如果没有任何浏览器客户端连着，提问没有 host 备份；审批和完成在心跳为隐藏或过期时仍可走原生通知。
- 第一次访问可能弹出 toast，询问浏览器通知权限。该权限只用于回退。

## 开发

```bash
npm test
npm run check
```

`lib/` 是发布权威。浏览器半边是手写的 `window.__ModuleLoader__` bundle，和其他可选 DSH Web 插件一致。

## 许可

MIT。
