# 变更记录（按轮次，每轮都有实测或守门对应）

> 完整证据（怎么验的、抓到什么缺陷）见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 0.5.0 — 手动关闭：插件没认出来时，人自己收口

**问题**：自动收口只认 `Q-2 选 B` 这一种形态。人用别的话答了（或者压根不是在会话里答的），
条目就永远挂在「待拍」里，越积越多，板子随之失去可信度 —— 而人除了手改 JSON 没有别的出口。

**改法**：抽屉里每条**未定**决策多一个「手动关闭」按钮。

- **两步**：第一次只把按钮变成「确认关闭？（它不会发消息）」，第二次才真写 —— 防一次误点关掉还在等人拍板的条目；
- 落库：`status=decided` + `decided = { value: '', at, by: 'user', note, manual: true }`；
- **不记选项**：`dismiss` 带 `value` 会被宿主回 400 —— 关闭不是选票，不能让看板谎称「定了某个方案」；
- **不填输入框、不发消息**：只填不发的红线不变；
- 已 decided 的再关一次回 400（不覆盖原来的 `by`/`at`）；未知 id 回 400 且不写文件；
- 卡片上写明「人工关闭：只表示这条不用再等，没记选项」；复述句是「已定：Q-16（手动关闭）」，刻意不含「选」字。

**实现要点**：`manual` 是 `decided` 里的新字段 —— 而 `normalizeDoc` 的 decided 投影是**手写字段清单**，
漏了它读一次盘就没了（手动关闭的条目会退化成空标签）。已加专门往返断言，并用「删掉这一行 ⇒ 该断言必红」验证过。

**验证**：80 条全绿（+14）。三个变异各自红在预期断言上：
① 宿主把 `dismiss` 开关钉成 false ⇒ 4 条 dismiss 用例红；
② 删掉 normalizeDoc 里的 `manual` ⇒ 往返断言红；
③ 去掉面板里的两步确认 ⇒「第一次点击不能写任何东西」红。

## 0.4.0 发布记录

- 已发布到 npm（`dsh-decisions-board@0.4.0`，14 文件 / 217.2 kB），**首发进入 staged 审核**；
- 发布凭据要求 Automation token（会话 token 会被 403 挡下），详见 `docs/marketplace-submit.md`。

## 0.4.0 — 修重复决策项：新增前先判重

**问题**：`action=add` 完全没有去重（只靠自动编号避开 id 冲突）；自动捕获路径只比对
`title + question` 的**精确**字符串 —— 模型换一种措辞描述同一件事，就漏过去了，看板上叠出两张几乎一样的卡片。

**改法**：两条写入路径（工具 + 标记块）共用同一个判定 `findDuplicate()`：

- `id` 相同（显式撞号报错，不静默合并）；
- 标题 + 问题**归一化后**相同（去空白、去标点、统一全半角与大小写）；
- 标题相同且选项 `key` 集合相同（挡住「问题被改写」）；
- 标题相同且两边都没有选项（「要不要」型）。

命中时不新增，只 `fillMissingFields()` **补空**（问题/选项/建议/影响/链接/原话），返回值带 `duplicate`。
同一消息里的多个块也能互相判重（比对快照随新增更新）。

守护 8 条（模型 4 + 宿主 4），共 66 条全绿。
## 0.3.0 — 装完即用：模型写标记块，插件自动落条目

- 新增 ctx.systemPrompt.section() 注入：告诉模型「要人拍板时在消息末尾写 :::decisions JSON 块」——
  不需要改任何项目的 AGENTS/宪法；
- 订阅 session/event 的 assistant/message，解析标记块 → 自动 add（id 自动编号、写前归一化校验、去重）；
- 边界：只解析标记块，块外不读不存；autoCapture: false 可关；
- 守门 5 条：提示段内容、块→落盘、重复投递不重复、坏 JSON 不写、开关关闭时零订阅。
## 0.2.1 — 修工具描述的漂移（直接决定"能不能用起来"）

- `decisions_board` 的描述重写：会话级路径 + 三个 action + 「要人拍板时先 add」；
- 加漂移守卫：描述缺关键字即测试红；
- 补 `engines`（node / dsh）与 `dsh.manifestVersion`；README 增「即插即用吗」与「首次使用」。
## 0.2.0 — 可分发形态

- 新增 `examples/decisions.sample.json`（一条带选项 + 一条「要不要」+ 一条已定），可直接用 `--file` 试；
- 新增 `docs/images/`（真机截图三张）与本文件；
- `files` 扩到 `examples`、`docs/images`、`CHANGELOG.md` —— 拿到 tgz 的人不必回仓库找文档；
- 功能无变化（逻辑停在 0.1.9）。

## 0.1.9 — 让「新增待拍项」变成一次调用

- 工具 `decisions_board` 增加 `action=add`：id 自动编号、目录/文件不存在自动建、写盘前先归一化校验；
- 守门：文件不存在也能建、连续编号、四类非法输入被拒、写后即读。

## 0.1.8 — **会话级隔离**（破坏性变更）

- 数据从 `<工作区>/.dsh/decisions.json` 改为 `<工作区>/.dsh/decisions/<sessionId>.json`；
- 缺 `sessionId` 直接 400，不再悄悄退化成工作区共享；会话 id 收窄字符集并断言不跳出目录；
- 旧文件不再读取（旧文件不再读取，需要时自行备份）。

## 0.1.7 — 自动收口（不需要任何项目约定）

- 订阅宿主 `session/event` 的 `user/message`：人一发 `Q-16 选 是`，条目当场 `decided`（`by: user-message`）；
- 边界收窄：只认 `source.kind === "user"`、只匹配 `id + 选 + 值`、认不出就不动；可 `autoSettle: false` 关；
- 实测：用户发出 `Q-16 选 否` 后同一秒落盘。

## 0.1.6 — 两个收口方向 + 渲染守卫

- 人点「我已发送」→ `confirm: true`；agent 侧新增 `decisions_board action=settle`；
- 复述句由宿主统一产出（`settleSentence`），两条路径措辞一致；
- 修：轮询每 1–2 秒整棵重建 DOM ⇒ 点击可能落在已丢弃的节点上（「点了没反应」）。

## 0.1.5 — 修「静默丢板」

- 点选项只落 `status: "filled"`（已回填·待发送），条目**继续留在清单**；
- 只有人点「我已发送」或 agent 收口才变 `decided`；角标显示 `待拍 N · 待发 M`。

## 0.1.4 — 「要不要」型也能点

- 空 `options` 合成 `是 / 否` 两个选项，并标 `synthetic`（不冤枉作者「未给代价」）；
- 空 options 的条目只接受 `yes`/`no`。

## 0.1.3 — 绕开被劫持的 `insertText`

- 回填改走 `setDraft` + `composeNextDraft`（同 id 换答案时替换那一行，不叠加矛盾指令）；
- 起因：`dsh-voice-plus` 把会话共享的 `inputActions.insertText` 猴补丁成「转写 → LLM 校对 → 延迟写回」，把我们的句子改写了。

## 0.1.2 — 修编译/写盘两处

- `decide` 的 URL 漏了 `?sessionId=` ⇒ 宿主 400（角标能读、点选回不来）；抽 `endpointUrl` 两处共用；
- 写盘基于 `raw` 而非归一化副本，保住人手加的自定义字段。

## 0.1.1 — 修 400 被吞成 200

- `bad()` 吞掉 status 参数 ⇒ 未知 id 的 decide 也回 200（前端以为写成功了）。

## 0.1.0 — 第一版

- 会话区右上角入口（`conversation.session.header.actions`）+ 420px 抽屉；
- 只有「点选项 → 写 decided → 回填输入框」这一条路。