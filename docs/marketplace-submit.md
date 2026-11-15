# 投稿到 awesome-dsh-plugin：完整步骤与卡点

> 依据：`contributing.md`（2026-11-15 拉取，262 行）。要点已在此复述并落到本仓库的具体动作上。
> 原始副本留在 `.research/awesome/contributing.md`（不进仓库，见 `.gitignore`）。

## 一句话结论

**投稿本身只要一个文件（5 行 YAML）**，但有三件事必须先做好：仓库公开、仓库**建满 1 天**、加 `dsh-plugin` topic。
前两件不是能「顺手」完成的 —— 时间必须真实流逝。

## 零、仓库已重建并推送（2026-11-15 21:47 +08:00）

| 项 | 值 |
| --- | --- |
| 远端 | <https://github.com/Sandwich-git/dsh-decisions-board> |
| 分支 / HEAD | `main` · `329b47e`（**单条提交**） |
| 入库文件 | **35 个**（`.research/` 36.5 MB、`*.tgz`、`.dev/` 均在 `.gitignore`） |
| 历史 | **仓库已删除并重建**：旧历史里含内项目路径与内部文档引用，且 force push 清不掉已 push 的对象（见下），故直接重建 |
| 内容扫描 | 项目名 / 内部文档章节引用 / 本机绝对路径 / 用户名 —— 工作树与远端均为 **0**（用 GitHub API 读，绕过 raw CDN 缓存） |
| 测试 | 58/58 绿（`node --test`，零依赖，不需要 install） |
| 图标 URL | `assets/icon-180.png` → 200（19201 B） |
| topics | **空，待加 `dsh-plugin`** |
| 建仓时间 | `2026-11-15T13:39:39Z` ⇒ **满 24 小时 = 2026-11-16 21:39:39 +08:00** |

### 还差两件，都不是写代码能解决的

1. **加 `dsh-plugin` topic**（CI 硬要求；本机浏览器未登录 GitHub，无法代劳）
   → 打开 <https://github.com/Sandwich-git/dsh-decisions-board>，右侧 About 齿轮 → Topics 填 `dsh-plugin`；
2. **等到 2026-11-16 21:40 (+08:00) 之后**再提 PR（CI 自动查 `created_at`，不足 1 天直接红）。

两件都满足后，按 §四 提 PR —— 只加 `marketplace/Sandwich-git__dsh-decisions-board.yml` 这一个文件。

### ✅ 教训：`git push --force` 清不掉已 push 的对象

最初的处理是「把历史压成单条 + force push」。实测发现**不够**：

| 旧提交 SHA | `GET /repos/…/commits/<sha>` |
| --- | --- |
| `ff43074` / `c47e3c7` / `8bd56d5` / `25c45bf` / `e1525fa` / `da67c24` | **全部 200，仍可访问** |

**原因**：force push 只移动分支指针；GitHub 不会主动 GC 已被 push 过的对象，
而且仓库 Activity 页会把 force-push 前后的 SHA 列出来 —— 旧 SHA 不需要有人记住。

**处理**：删除仓库、同名重建、重新 push。重建后旧 SHA 返回 `409`（仓库曾为空）——
对象库随旧仓库一起消失，这是**唯一**能让旧提交真正不可达的常规手段。

> 若将来还要清理历史，顺序是：**先清洗工作树 → 删库重建 → 单次 push**，不要指望 force push。
> ⚠️ 一个实操提醒：`raw.githubusercontent.com` 有 CDN 缓存，刚 push 完立刻拉可能还是旧内容。
> 核对远端内容请用 GitHub API（`api.github.com/repos/.../contents/<path>`）或直接 clone。
## 一、必须先做的三件事

| # | 事 | 谁做 | 为什么 |
| --- | --- | --- | --- |
| 1 | 把本仓库推到 GitHub 公开 | 你（push 需要你的账号） | 条目 `url` 必须指向真实仓库；评审会**读源码**核对描述 |
| 2 | **建仓后等满 24 小时** | 时间 | CI **自动检查** `repo created_at`；不足 1 天直接红，且「重新提交不会有任何影响」 |
| 3 | 仓库 About 加 `dsh-plugin` topic | 你 | contributing 明列的要求 |

> ⚠️ 第 2 条是唯一无法用工作绕过的一条。建仓 → 等一天 → 再提 PR。

## 二、投稿文件（唯一要提交的东西）

目标路径：`data/plugins/<Sandwich-git>__dsh-decisions-board.yml` —— 文件名必须与**你的 GitHub 账号**一致。

本仓库已备好模板：`marketplace/Sandwich-git__dsh-decisions-board.yml`。

```yaml
url: https://github.com/Sandwich-git/dsh-decisions-board
name: Sandwich-git/dsh-decisions-board
category: ui
description:
  en: 'Adds a pending-decision board to the session header: ...'
```

**字段要点**

| 字段 | 说明 |
| --- | --- |
| `description.en` | **唯一必填项**。含冒号加空格必须整行加引号，否则 YAML 解析成嵌套键 —— 我们的描述里有 `header:`，所以**已加引号** |
| `description.zh` | 可选；不写维护者会补（缺翻译是我们的活） |
| `category` | 我们的入口在会话标题行 ⇒ `ui`。选偏了维护者直接改，不因此打回 |
| `icon` | 可选；GitHub 托管的**位图**，省略则回退到作者头像 |
| `tarball` | 可选；不发 npm 时指向 GitHub Release 的 `.tgz`。⚠️ 资产名**不要带版本号**（`latest/download/` 照字面取文件名，下次发版就 404） |

## 三、我们这边已满足 / 还需满足

| contributing 要求 | 我们 | 证据 |
| --- | --- | --- |
| `package.json` 声明 `dsh.bundle` | ✅ | `dsh.bundle.patch: ./cordis.patch.yml`（只有 `dsh.client` 是最常见的被拒原因） |
| 真实可用代码 | ✅ | `lib/index.js` 宿主半 + `lib/client.js` 浏览器半 + 58 条测试 |
| 活跃维护 | ✅ | 0.1.x → 0.3.1，`CHANGELOG.md` 记录了十轮迭代 |
| 描述属实 | ✅ | 逐句对得上代码；描述里的 session header / `Q-2 选 B` / `filled` 都能在仓库里找到 |
| 非聚合包 | ✅ | 无 dependencies，只有一个 `@deepseek-ai/cordis` peer |
| 一个 PR ≤ 3 条 | ✅ | 只加 1 条 |
| 建满 1 天 | ⏳ | 取决于你何时建仓 |
| `dsh-plugin` topic | ⏳ | 建仓后添加 |

## 四、提 PR 的具体动作

```bash
# 1) fork + clone 列表仓库
git clone https://github.com/<you>/awesome-dsh-plugin
cd awesome-dsh-plugin

# 2) 把模板复制进去（Sandwich-git 换成你的账号）
cp path/to/marketplace/Sandwich-git__dsh-decisions-board.yml \
   data/plugins/<you>__dsh-decisions-board.yml

# 3) 想预览那一行也可以本地生成（提交生成结果同样接受，但必须与数据源一致）
npm ci && node scripts/generate-readme.mjs

# 4) 提 PR：只加这一个文件
git checkout -b add-dsh-decisions-board
git add data/plugins/<you>__dsh-decisions-board.yml
git commit -F ../pr-message.txt   # 多行信息用 -F，不要用 -m
git push -u origin add-dsh-decisions-board
```

PR 标题与正文用 `marketplace/PR.md` 里的内容（含逐条自查表）。

## 五、会被打回的几种情况（提前避开）

| 情况 | 我们是否踩到 |
| --- | --- |
| 只声明 `dsh.client` | 否（有 `dsh.bundle`） |
| 描述夸大 / 提到不存在的命令或 API | 否（每条都能 grep 到） |
| 建仓不足 1 天 | **取决于你** |
| 一个 PR 塞多条 | 否（1 条） |
| 顺手改了别人的条目 | 否（只新增文件） |
| 手改 README | 否（README 是生成的，一个字节都不碰） |
| YAML 里冒号加空格没加引号 | 否（已加） |

## 六、可选的两个加分项

1. **图标**：`assets/icon-180.png`（本仓库已生成）→ 推到 `main` → 取消 yml 里 `icon:` 的注释；
2. **预构建 tarball**：发 GitHub Release，资产名用 `dsh-decisions-board.tgz`（**不带版本号**），
   然后启用 yml 里的 `tarball:` —— 市场会优先给下载链接，用户免构建授权。