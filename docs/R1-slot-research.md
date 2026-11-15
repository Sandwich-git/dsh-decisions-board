# R-1 结论：会话区右上角能否注册？（已取证）

> 取证方式：解析 `<安装目录>/resources/app.asar`（31,917 条目，`DATA = 8 + headerPickleSize = 8324880`），
> 用 `tools/asar.py` 抽 `@deepseek-ai/dsh-client-ui-*` 与相关宿主包到 `.research/asar/`，再逐文件读源码。
> 结论只引用**被读到的代码行**，不引用 README 措辞（README 只用作旁证）。

## 1. 一句话结论

**能注册，但不在 `dsh-client-ui-layout` 里** —— layout 没有 header slot；
真正提供「会话区右上角」的是 **`dsh-client-ui-conversation`**，它声明了
**`conversation.session.header.actions`（kind: list / scope: session）**，这就是我们要注册的位置。

## 2. layout 到底声明了什么（`dsh-client-ui-layout/lib/client.js:699-731`）

```js
ctx.slots.register({
  name: "root",
  locale: "common",
  children: {
    "desktop.mode.content": { kind: "single", scope: "root" },
    "sidebar":              { kind: "single", scope: "root" },
    "main":                 { kind: "keyed",  scope: "root" },
    "rightbar":             { kind: "single", scope: "root" },
    "shell.bottom":         { kind: "single", scope: "root" },
    "shell.overlay":        { kind: "list",   scope: "root" },
    "shell.leading":        { kind: "single", scope: "root" }
  },
  store, inject: () => ({ hooks: { foldedLandscape } })
}, AppFrame)
```

⇒ layout 的对外扩展点是**外壳级**的四个：`shell.leading`（窗口左缘/标题栏座位）、
`shell.bottom`（底部一条）、`shell.overlay`（整框浮层）、`sidebar`/`main`/`rightbar`（三个主区）。
**没有 header**。`renderSlot("shell.leading"|"shell.bottom"|"shell.overlay")` 的渲染位置见同文件 348-411 行。

## 3. 「会话区右上角」的真实归属（`dsh-client-ui-conversation/lib/client.js:22929-22953`）

```js
const registerSessionHeader = () => slots.register({
  name: "conversation.session.header",
  locale: NS,
  children: {
    "conversation.session.header.lineage":        { kind: "single", scope: "session" },
    "conversation.session.header.actions":        { kind: "list",   scope: "session" },
    "conversation.session.header.utilities":      { kind: "list",   scope: "session" },
    "conversation.session.header.corner":         { kind: "single", scope: "session" },
    "conversation.session.header.views.actions":  { kind: "list",   scope: "root"    }
  }, store: conversationStore, ...
```

渲染顺序（同文件 20850-20907）：`titleRow` = [ `titleCluster`（面包屑 + **`headerActions`**） ] + [ `headerUtilities` ] + [ `headerCorner` ]。
⇒ `actions` 就在会话标题行**右侧那一串按钮的第一段**，即「会话区右上角」。

## 4. 三个候选位，为什么选 actions

| slot | kind | 现状 | 判断 |
| --- | --- | --- | --- |
| `conversation.session.header.actions` | **list** | `ui-jobs`（id: `job-list`, order: 20）、`ui-subagent`、`ui-agent-preset` 已入驻 | ✅ **选它**：list 可多条目，天然是「一排按钮」 |
| `conversation.session.header.utilities` | list | `ui-open-in-app`、`ui-schedule` | 可用，但语义是「工具/实用入口」，比 actions 弱 |
| `conversation.session.header.corner` | **single** | 已被 `ui-sidebar-right`（右侧栏展开按钮）独占（`dsh-client-ui-sidebar-right/lib/client.js:5718`） | ⛔ 不能用：single 只容一个占位者 |

## 5. 注册写法（照 `dsh-client-ui-jobs/lib/client.js:891-902` 的形状）

```js
ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
  name: "conversation.session.header.actions",
  id: "decisions-board",
  order: 30,
  // 可选：locale: "..." / inject: () => ({ hooks, ...业务字段 })
}, DecisionsBadge))
```

组件收到的 props（`scope: "session"` ⇒ 会话标准 props + 注入 share）：
- `sessionId`（见 jobs 组件签名 `JobListAction({ sessionId, useJobs, ..., t })`，jobs client.js:323）
- `inputActions`（`ui-session` 的 standard props：`dsh-client-ui-conversation/lib/client.js:22783-22799`
  `ctx.uiSession.provide({ props: ["inputActions"], ... props: { inputActions: shell.actions } })`）
  ⇒ **这就是「回填输入框」的官方口子**，动作面见 `SessionInputShell.actions`（同文件 15368-15395）：
  `setDraft(text)` / `insertText(text, span)` / `captureInsertion()` / `submit()`。
  ⚠️ 我们**只调 setDraft/insertText**，绝不调 `submit()` —— 对应本插件的一条红线：**不自动发送**。
- `t`（仅当 registration 传了 `locale`）

## 6. 对方案的修正

设计意图是「位置在会话区域右上角（header 右侧）」，当时尚未确认能否注册——
**确认结果：可以**，但实现上不是「往 layout 的 header 插槽注册」，而是
「往 **conversation** 声明的 session header actions 列表注册」。当时的兜底方案
（「退回 statusbar 或路径 B」）**不需要启用**。

## 7. 附带确认（同轮取证，供后续步骤）

| # | 未知 | 结论 | 证据 |
| --- | --- | --- | --- |
| R-2 | client plugin 清单字段 | `main`+`exports["."]`（宿主半）+ `exports["./client"]`（浏览器半）+ `dsh.client.platform:"web"` + `dsh.client.inject` | `dsh-client-ui-deliverables/package.json`、`dsh-client-ui-goal/package.json` |
| R-2' | 浏览器半的产物格式 | 必须是**已构建单文件**：`window.__ModuleLoader__.load({ id, factory: (require) => {...} })`；`require` 只能拿共享基线 | `dsh-client-ui-jobs/lib/client.js:1-10`；`dsh-client-modules/README.zh.md`「构建要求」 |
| R-2'' | 宿主↔浏览器怎么通信 | 宿主半 `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` 起 `/api/...` 路由；浏览器侧直接同名 `fetch()` | `dsh-client-ui-deliverables/lib/index.js:49-98` + 其 `lib/client.js:421,441` |
| R-4 | decisions.json 放哪 | workspace：`<会话工作目录>/.dsh/decisions.json`；宿主用 `workspaceRegistry.list()[].sessionIds/path` 反查会话目录，兜底 `sandboxPolicy.workspaceRoot` | `dsh-workspace/lib/index.js:90,102`（`get path` / `get sessionIds`） |
| R-7 | 安装通道 | `install_local_workbench` **硬校验**清单：`dsh.bundle.patch` + `dsh.client.platform==='web'` + `dsh.client.inject` **必须含 `dsh-desktop-workbenches`** + `exports["./client"]`，tgz ≤ 8 MiB | `dsh-desktop-workbenches/local-install.mjs:31-37` |
| R-3 | 热更 | 仅 `pnpm run dev:web` 时生效；否则改完必须重启 Harness | `dsh-client-modules/README.zh.md`「插件动态组合」/「构建要求」 |
