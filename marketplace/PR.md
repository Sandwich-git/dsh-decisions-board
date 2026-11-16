# PR: add dsh-decisions-board

## Title / 标题

```text
Add dsh-decisions-board — pending-decision board in the session header
```

## Body / 正文

```markdown
Adds one entry: `data/plugins/Sandwich-git__dsh-decisions-board.yml`.

What it does (verified against the repo, not from memory):

- **A board in the session header** — a badge `⚖ 待拍 N · 待发 M` and a 420 px drawer listing pending decisions.
- **Agents write entries two ways** — the `decisions_board` tool (`action=add`), or a `:::decisions` block in a message. For the block, the plugin injects one `systemPrompt.section()` of its own telling the model the format, so nothing has to be added to a project's own instructions.
- **Clicking an option never sends** — it writes `status: "filled"` and fills the composer via `setDraft` with `Q-2 选 B`, leaving the entry visible. Only an explicit confirm, or the user actually answering in the conversation (`session/event` → `user/message` → `decided`), closes it. Nothing is removed while unconfirmed, which is the point: a decision that was never sent must not disappear.
- **Duplicates do not stack** — both writing paths look for an existing entry first (same id, or the same title+question after normalising width/spacing/punctuation, or the same title with the same options), and fill the missing fields of that entry instead of appending a second one.
- **Per-session data** — `<session workdir>/.dsh/decisions/<sessionId>.json`. Two sessions in one workspace do not see each other's boards; a missing file reads as an empty board instead of an error.

`dsh.bundle` is declared (`dsh.bundle.patch: ./cordis.patch.yml`), plus `dsh.client` for the browser half.

Not a meta-package: no dependencies beyond a `@deepseek-ai/cordis` peer; the host half and the browser half are in this repo.

Tests: 66 across four files (`node --test tests/*.test.mjs`), covering the model, the packaged bundle, the host routes/tool/capture, and the client fill path. Runtime evidence (real Harness, real Chromium) is recorded in `docs/VERIFICATION.md`.
```

## Checklist / 自查（对照 contributing.md）

| 要求 | 状态 |
| --- | --- |
| `dsh.bundle` 声明 | ✅ `dsh.bundle.patch: ./cordis.patch.yml` |
| 真实可用代码（非占位/纯 README） | ✅ 宿主 500+ 行、浏览器半、66 条测试 |
| 仓库创建满 1 天（CI 自动查） | ✅ 建仓于 2026-11-15 21:39 (+08:00)，提 PR 时已满 24 小时 |
| 加 `dsh-plugin` topic | ✅ 已在 About 里添加 |
| 描述属实、无营销词 | ✅ 逐句对得上代码；无「最好/最强」类词 |
| 每个 PR ≤ 3 条 | ✅ 只加 1 条 |
| 只改自己的条目 | ✅ 只新增一个文件 |
| `@deepseek-ai/*` 用 peerDependencies | ✅ 只有 `@deepseek-ai/cordis` 一个 peer |
