# dsh-attention

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 用的桌面注意力提醒。

会话跑完一轮就提醒（**无差别**，包括你正在看的这条）；agent 等审批 / 提问 / 计划审阅时，在页面不在前台的情况下提醒。它是可分发的 DSH bundle，不是对 shell 的修改。

## 做什么

| 事件 | 何时提醒 |
|---|---|
| 任务完成（任意会话，包括你正在看的这条） | 总是提醒：声音 + 标签标题闪烁 + 系统横幅 |
| 审批 / 计划审阅 / 提问 | 页面在后台或失焦时 |

各通道独立，可在 **设置 → 提醒** 分别开关：

| 通道 | 归属 |
|---|---|
| 短提示音（Web Audio，OpenCode/Codex 风格） | 页面，只要页面开着 |
| 标签标题前缀 + favicon 红点 | 页面（等待类事件持续显示；完成闪烁约 4 秒） |
| 系统原生横幅（`osascript` / `notify-send` / Windows toast） | Host |

**单一生产者规则**：浏览器标签活着（心跳 8 秒内新鲜）时，横幅和铃声都归页面，Host 让位；所有标签关闭或冻死时，由 Host 自己出横幅（带内置铃声）——不重复、也不漏。完成和瀑布审批回落到 Host 铸造的会话内序号。提问/计划审阅占用一个 live slot：第一个标签 `open` 铸造身份，后续标签折叠，等待从列表消失时 `close` 释放，下一次真实提问才能再响。同一身份的并发上报走 singleflight：Host 只给其中一个调用者授予 `sound` 和 `fallback`。Client 侧原生失败会软记账（回声折叠）；备份失败不占账本，恢复中的第一个标签可以回退。偏好尚未加载完时观察到的完成边沿会先暂存、加载后补发。

原生通知程序缺失时（如未装 `notify-send`），Host 会如实上报，「提醒」页显示系统通知不可用，并自动改走浏览器 `Notification` 回退。

## 安装

首选——用固定 release tag 配合包自带的无参数安装器：

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.0
```

不带子命令等同 `install`。安装器只改目标 profile（默认 `web`）`package.json` 里的 `dependencies.dsh-attention` 和 `dsh.profile.bundles`，用临时文件加原子 rename 写入，然后在该 profile 目录运行 `pnpm install --ignore-scripts`。它不会停止或重启 DSH。

查看安装状态：

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.0 status
```

卸载（幂等——重复执行安全；依赖安装失败时自动恢复原 manifest）：

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.0 uninstall
```

所有命令都支持 `--profile <name>`（默认 `web`）、`--source <source>`、`-h`/`--help`。默认 source 固定在当前 SemVer tag；本地开发可用 `link:` 指向 checkout：

```bash
npx --yes github:shaomingbo/dsh-attention#v0.1.0 --source link:/path/to/dsh-attention
```

安装或卸载后：手动重启 `dsh web`，然后硬刷新浏览器。

手动兜底——直接编辑 `~/.dsh/profiles/web/package.json`：

```json
{
  "dependencies": {
    "dsh-attention": "github:shaomingbo/dsh-attention#v0.1.0"
  },
  "dsh": {
    "profile": { "bundles": ["dsh-attention"] }
  }
}
```

然后在该 profile 目录运行 `pnpm install --ignore-scripts` 并重启 DSH。

如果你用 `dsh plugin` 管理 bundle，等价命令是 `dsh plugin --profile web add|update|remove dsh-attention`。

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

- 任务完成**无差别**提醒——正看着页面也会响。审批与提问在你看着页面时保持安静。
- 原生通知仅限 loopback。远程 Web GUI 不能触发本机通知。
- Host 监听 `approval/request`，但一定会 `next()`，绝不代替你做审批决定。
- 第一次访问可能弹出 toast，询问浏览器通知权限。该权限只在原生通知不可用时作回退。

## 开发

```bash
npm test
npm run check
```

`lib/` 是发布权威。浏览器半边是手写的 `window.__ModuleLoader__` bundle，和其他可选 DSH Web 插件一致。

## 许可

MIT。
