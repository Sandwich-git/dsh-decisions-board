/**
 * dsh-decisions-board —— 宿主半（Node）。
 *
 * 职责只有两件：
 *   1. 把 <会话工作目录>/.dsh/decisions.json 读出来给浏览器；
 *   2. 把「人点了 A」写回同一个文件的 decided 字段（唯一允许的写操作）。
 * 其余字段一律只读 —— 插件不得成为第二份真值（这是本插件的硬边界）。
 *
 * 路由放在自己的前缀 /api/decisions-board/ 下（不与 Desktop 或其他插件抢路径）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { applyDecisionToRaw, buildView, composeFill, composePendingItem, extractDecisionBlocks, matchSettlement, normalizeDoc, openItems, settleSentence, withDecision } from '../src/model.js';

/** 浏览器与宿主使用的相对路径（不带前导斜杠，浏览器侧同名 fetch）。 */
const STATE_PATH = 'api/decisions-board/state';
const DECIDE_PATH = 'api/decisions-board/decide';
/**
 * 数据文件的位置：<workspace>/.dsh/decisions/<sessionId>.json
 *
 * 为什么是**会话级**而不是工作区级：同一个工作区里会有多个会话（不同任务、不同时间），
 * 它们的待拍项本来就不是一回事；共用一个文件会让 A 会话的板子出现在 B 会话里。
 * 目录（而非单文件）也让「同一工作区的几条会话」在磁盘上一眼可数。
 */
const SESSION_DIR = join('.dsh', 'decisions');

/** 会话 id 直接当文件名用，必须先收窄字符集（防 ../ 与非法字符）。 */
function sessionFileName(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/gu, '_');
  if (safe === '' || safe === '.' || safe === '..') throw new Error('invalid sessionId: ' + String(sessionId));
  return safe + '.json';
}

function sessionFilePath(dir, sessionId) {
  return join(dir, SESSION_DIR, sessionFileName(sessionId));
}
/** 8 MiB 以上的 decisions.json 直接拒绝 —— 它是给人看的清单，不是数据库。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const name = 'dsh-decisions-board';
export const inject = ['connection', 'sandboxPolicy'];

function noStore(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function bad(message, status) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: status ?? 400,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/**
 * 找出某个会话的工作目录。
 * 先问 workspaceRegistry（它按规范路径记录每个项目下的 sessionIds），
 * 再退回宿主默认 workspaceRoot。两者都拿不到时返回 undefined，由调用方报错。
 */
function workspaceDirFor(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  const registry = ctx.get('workspaceRegistry');
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        const ids = workspace.sessionIds;
        if (Array.isArray(ids) && ids.includes(sessionId)) return workspace.path;
      }
    } catch {
      // 注册表读取失败不影响兜底路径。
    }
  }
  const policy = ctx.get('sandboxPolicy');
  return policy === undefined ? undefined : policy.workspaceRoot;
}

/**
 * 解析本次请求要操作的 decisions 文件（会话级）。
 * 优先级：插件配置 file（绝对路径，显式覆盖）> dir + sessionId > sessionId（反查工作区）。
 */
function resolveFile(ctx, config, query) {
  const configured = typeof config?.file === 'string' ? config.file.trim() : '';
  if (configured !== '') {
    if (!isAbsolute(configured)) throw new Error('config.file must be an absolute path');
    return configured;
  }
  const sessionId = (query.get('sessionId') ?? '').trim();
  if (sessionId === '') throw new Error('sessionId is required: the board is per-session');
  const explicitDir = query.get('dir');
  if (explicitDir !== null && explicitDir !== '') {
    if (!isAbsolute(explicitDir)) throw new Error('dir must be an absolute path');
    return sessionFilePath(explicitDir, sessionId);
  }
  const workspaceDir = workspaceDirFor(ctx, sessionId);
  if (workspaceDir === undefined || workspaceDir === '') {
    throw new Error('cannot resolve a workspace directory for session ' + sessionId);
  }
  return sessionFilePath(workspaceDir, sessionId);
}

/** 读文件；不存在就当作空文档（不是错误：人还没让 agent 写过）。 */
async function readDoc(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const empty = { version: 1, session: '', items: [] };
      return { doc: normalizeDoc(empty).doc, problems: [], missing: true, raw: empty };
    }
    throw error;
  }
  if (raw.length > MAX_FILE_BYTES) throw new Error('decisions.json is larger than 8 MiB');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('decisions.json is not valid JSON: ' + String(error?.message ?? error));
  }
  const { doc, problems } = normalizeDoc(parsed);
  // raw 也要带出去：写盘时必须基于它，否则会丢掉 normalizeDoc 不认识的字段。
  return { doc, problems, missing: false, raw: parsed };
}

/** 原子写：先写同目录临时文件再 rename，避免人看到半截 JSON。 */
async function writeDoc(file, doc) {
  await mkdir(dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(temp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  await rename(temp, file);
}

function stateBody(file, read) {
  return {
    ok: true,
    file,
    missing: read.missing,
    problems: read.problems,
    view: buildView(read.doc, 5)
  };
}

async function handleState(ctx, config, request, log) {
  const query = new URL(request.url).searchParams;
  let file;
  try {
    file = resolveFile(ctx, config, query);
  } catch (error) {
    return bad(String(error.message), 400);
  }
  try {
    const read = await readDoc(file);
    log?.('info', '[dsh-decisions-board] state: session=' + (query.get('sessionId') ?? '') + ' file=' + file);
    return noStore(stateBody(file, read));
  } catch (error) {
    return bad(String(error?.message ?? error), 500);
  }
}

async function handleDecide(ctx, config, request, log) {
  const query = new URL(request.url).searchParams;
  let file;
  try {
    file = resolveFile(ctx, config, query);
  } catch (error) {
    return bad(String(error.message), 400);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return bad('body must be JSON', 400);
  }
  if (body === null || typeof body !== 'object') return bad('body must be a JSON object', 400);
  try {
    const read = await readDoc(file);
    // confirm=true 才是「人确认已发送」；默认只写 filled（已回填待发送），不把板子拍死。
    const patch = { id: body.id, value: body.value, note: body.note, by: body.by, confirm: body.confirm === true };
    // 1) 校验（未知 id / 非法选项值在这里抛）；
    const validated = withDecision(read.doc, patch);
    // 2) 写盘基于 raw —— 只改 status 与 decided，其他字段（含人手加的）原样保留；
    const rawNext = applyDecisionToRaw(read.raw, patch);
    await writeDoc(file, rawNext);
    // 3) 响应里的 view 从刚落盘的那份重新归一化出来，保证「看到的 = 文件里的」。
    const written = normalizeDoc(rawNext);
    return noStore({
      ...stateBody(file, { doc: written.doc, problems: written.problems, missing: false }),
      fill: validated.fill,
      ...body.confirm === true ? { sentence: settleSentence(validated.item, body.value) } : {}
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    const clientFault = message.startsWith('unknown decision id') || message.startsWith('decision value');
    return bad(message, clientFault ? 400 : 500);
  }
}

/**
 * 工具用的路径解析。
 * 优先用 exec.agent.session（就是发起这次调用的会话）—— agent 不必知道自己的 session id；
 * 显式 dir / sessionId 只在测试或代他人收口时用。
 */
function resolveFileForTool(ctx, settings, dir, sessionId) {
  const configured = typeof settings?.file === 'string' ? settings.file.trim() : '';
  if (configured !== '') {
    if (!isAbsolute(configured)) throw new Error('config.file must be an absolute path');
    return configured;
  }
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id === '') throw new Error('cannot tell which session this is; pass sessionId=<id>');
  if (typeof dir === 'string' && dir.trim() !== '') {
    if (!isAbsolute(dir)) throw new Error('dir must be an absolute path');
    return sessionFilePath(dir, id);
  }
  const workspaceDir = workspaceDirFor(ctx, id);
  if (workspaceDir === undefined || workspaceDir === '') {
    throw new Error('cannot resolve a workspace directory for session ' + id + '; pass dir=<absolute dir>');
  }
  return sessionFilePath(workspaceDir, id);
}

/**
 * 给 agent 用的一条工具：list 看还等着人动手的条目，settle 收口为 decided。
 *
 * 为什么要有它：人点「我已发送」只解决了一个方向；另一个方向是「agent 看到人的回答后把 filled 改成 decided」。
 * 让 agent 手改 JSON 既容易写错，也容易忘。工具把这件事变成一次调用，并把复述句原样给出来。
 */
function registerTool(ctx, settings, log) {
  whenService(ctx, 'tools', (owner) => registerToolOn(ctx, owner, settings, log), log);
}

function registerToolOn(ctx, owner, settings, log) {
  let tools;
  try {
    tools = owner.get('tools');
  } catch {
    tools = undefined;
  }
  if (tools === undefined || typeof tools.register !== 'function') {
    log('warn', '[dsh-decisions-board] tools 服务不可用，decisions_board 工具未注册（界面仍可用）');
    return;
  }
  try {
    tools.register({
      name: 'decisions_board',
      // 这段描述是模型决定「要不要用这个工具」的唯一依据：必须写清什么时候该写、数据在哪、三个 action 各做什么。
      // 它有漂移风险（历史上就漂过一次：路径还写着工作区级、action 少了 add），tests/host.test.mjs 有守卫断言关键字。
      description: [
        '维护「待拍板」清单（数据在 <会话工作目录>/.dsh/decisions/<sessionId>.json，每个会话一份）。',
        '当你要人拍板时，先用 action=add 把这条写进看板（id 可省略，自动编号），再在对话里提问 ——',
        '这样人不必翻聊天记录就能看到原委。',
        'action=list 列出还等着人动手的条目（pending + filled）与建议复述句；',
        'action=settle 把人已确认送达的那条收口为 decided，返回「已定：Q-16 选 是」这样的复述句。'
      ].join(''),
      parameters: {
        action: { type: 'string', required: true, description: 'add = 新增待拍项；list = 查看；settle = 收口为 decided' },
        title: { type: 'string', description: 'add 必填：一句话说明要人拍什么' },
        kind: { type: 'string', description: 'add：caliber / scope / contract / priority / choice（默认 choice）' },
        question: { type: 'string', description: 'add：为什么需要拍板（一两句）' },
        options: { type: 'array', description: 'add：选项数组 [{key,label,cost}]；要不要型可留空，UI 会给 是/否' },
        recommended: { type: 'string', description: 'add：建议的 option.key' },
        impact: { type: 'array', description: 'add：影响标签' },
        links: { type: 'array', description: 'add：文档锚点（只放引用，不复制正文）' },
        quote: { type: 'string', description: 'add：人类原话一小段（80 字内），原委里最有价值的一行' },
        id: { type: 'string', description: 'add 可显式指定 id（默认自动编号）；settle 时必填' },
        value: { type: 'string', description: 'settle 时的答案；省略则沿用该条已回填的 decided.value' },
        note: { type: 'string', description: 'settle 时写入的备注' },
        dir: { type: 'string', description: 'workspace 绝对路径；省略则用当前会话的 cwd' },
        sessionId: { type: 'string', description: '要操作的会话 id；省略则用当前会话（一般不用填）' }
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
      async execute(args, exec) {
        // exec.agent.session 就是当前会话：id 与 cwd 都在 header 上，不用 agent 自报。
        const session = exec?.agent?.session;
        const sessionId = typeof args?.sessionId === 'string' && args.sessionId.trim() !== ''
          ? args.sessionId.trim()
          : (session?.header?.id ?? session?.id);
        const dir = typeof args?.dir === 'string' && args.dir.trim() !== ''
          ? args.dir
          : session?.header?.cwd;
        const file = resolveFileForTool(ctx, settings, dir, sessionId);
        const read = await readDoc(file);
        const action = String(args?.action ?? '');
        if (action === 'add') {
          const item = composePendingItem({
            id: args?.id,
            kind: args?.kind,
            title: args?.title,
            question: args?.question,
            options: args?.options,
            recommended: args?.recommended,
            impact: args?.impact,
            links: args?.links,
            quote: args?.quote
          }, read.doc.items.map((existing) => existing.id));
          // 先归一化一遍：让会掉字段的写法在写入前就报错，而不是进了文件才被静默纠正。
          const check = normalizeDoc({ version: 1, session: read.doc.session, items: [item] });
          const problems = check.problems.filter((entry) => entry.startsWith(item.id));
          if (problems.length > 0) throw new Error('条目不合法：' + problems.join('；'));
          const raw = read.raw !== null && typeof read.raw === 'object' ? read.raw : { version: 1, session: '', items: [] };
          if (!Array.isArray(raw.items)) raw.items = [];
          raw.items.push(item);
          await writeDoc(file, raw);
          log?.('info', '[dsh-decisions-board] 新增待拍项 ' + item.id + ' -> ' + file);
          return {
            file,
            added: item.id,
            item: check.doc.items[0],
            pendingCount: read.doc.items.filter((existing) => existing.status === 'pending' || existing.status === 'filled').length + 1
          };
        }

        if (action === 'list') {
          const open = openItems(read.doc).map((item) => ({
            id: item.id,
            status: item.status,
            title: item.title,
            kind: item.kind,
            question: item.question,
            options: item.options.map((option) => ({ key: option.key, label: option.label, cost: option.cost })),
            recommended: item.recommended,
            filledValue: item.decided === null ? null : item.decided.value,
            // 人已经点了但还没确认送达的，先把复述句准备好。
            sentence: item.decided === null
              ? composeFill(item, item.recommended !== '' ? item.recommended : (item.options[0]?.key ?? 'yes'))
              : settleSentence(item, item.decided.value)
          }));
          return {
            file,
            missing: read.missing,
            pendingCount: open.length,
            filledCount: open.filter((item) => item.status === 'filled').length,
            problems: read.problems,
            items: open
          };
        }
        if (action === 'settle') {
          const id = typeof args?.id === 'string' ? args.id.trim() : '';
          if (id === '') throw new Error('settle 需要 id');
          const item = read.doc.items.find((candidate) => candidate.id === id);
          if (item === undefined) throw new Error('unknown decision id: ' + id);
          const value = typeof args?.value === 'string' && args.value !== ''
            ? args.value
            : (item.decided === null ? '' : item.decided.value);
          if (value === '') throw new Error('settle 需要 value（该条还没有回填值）');
          const patch = { id, value, note: args?.note, by: 'agent', confirm: true };
          const validated = withDecision(read.doc, patch);
          await writeDoc(file, applyDecisionToRaw(read.raw, patch));
          return {
            file,
            settled: id,
            value,
            // 复述句：agent 应当原样在对话里复述一次（这样人和 agent 对同一件事用的是同一句话）。
            sentence: settleSentence(item, validated.item.decided.value),
            pendingCount: openItems(normalizeDoc(applyDecisionToRaw(read.raw, { ...patch })).doc).length
          };
        }
        throw new Error('unknown action: ' + action + ' (expected add | list | settle)');
      }
    });
    log('info', '[dsh-decisions-board] 工具已注册：decisions_board');
  } catch (error) {
    log('warn', '[dsh-decisions-board] 注册 decisions_board 失败：' + String(error?.message ?? error));
  }
}
/**
 * 自动收口：人在会话里把答案发出来 ⇒ 立刻把条目从 filled/pending 落成 decided。
 *
 * 这是「方向二」的正解 —— 不依赖任何项目宪法、skill 或 MCP：
 * 宿主机侧本来就有 session/event 钩子（user/message），插件能听见人发的消息。
 *
 * 边界（刻意收窄，写进 README）：
 *   · 只看 user/message 且 source.kind === 'user'（忽略 agent、user-rpc、系统注入）；
 *   · 只拿这条消息去匹配「我们自己填进去的那句话」的形态（id + 选 + 选项），不存原文、不外传；
 *   · 认不出就不动 —— 条目留在 filled 里可见，绝不猜。
 */
function fileForSession(settings, session) {
  const configured = typeof settings?.file === 'string' ? settings.file.trim() : '';
  if (configured !== '') return configured;
  const cwd = session?.header?.cwd;
  const id = session?.header?.id ?? session?.id;
  if (typeof cwd !== 'string' || cwd === '' || typeof id !== 'string' || id === '') return undefined;
  return sessionFilePath(cwd, id);
}

async function settleFromMessage(settings, session, event, log) {
  if (event?.type !== 'user/message') return;
  if (event.data?.source?.kind !== 'user') return;
  const blocks = Array.isArray(event.data?.content) ? event.data.content : [];
  const text = blocks
    .filter((block) => block !== null && block !== undefined && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  if (text === '' || !text.includes('选')) return;
  const file = fileForSession(settings, session);
  if (file === undefined) return;
  const read = await readDoc(file);
  const targets = [];
  for (const item of openItems(read.doc)) {
    const value = matchSettlement(text, item);
    if (value !== null) targets.push({ item, value });
  }
  if (targets.length === 0) return;
  let raw = read.raw;
  for (const target of targets) {
    raw = applyDecisionToRaw(raw, {
      id: target.item.id,
      value: target.value,
      by: 'user-message',
      confirm: true
    });
  }
  await writeDoc(file, raw);
  log('info', '[dsh-decisions-board] 按人的消息收口：' + targets.map((target) => target.item.id + '=' + target.value).join(', '));
}

/** 订阅 session/event（settings.autoSettle === false 时整体关掉）。 */
function registerAutoSettle(ctx, settings, log) {
  if (settings?.autoSettle === false) {
    log('info', '[dsh-decisions-board] autoSettle 已关闭：只在人点按钮或 agent 调工具时收口');
    return;
  }
  try {
    ctx.on('session/event', (session, event) => {
      // 事件是同步广播，异常必须自己吞掉，不能污染别人的会话。
      Promise.resolve()
        .then(() => settleFromMessage(settings, session, event, log))
        .catch((error) => log('warn', '[dsh-decisions-board] 自动收口失败：' + String(error?.message ?? error)));
    });
    log('info', '[dsh-decisions-board] 自动收口已开启（session/event: user/message）');
  } catch (error) {
    log('warn', '[dsh-decisions-board] 订阅 session/event 失败：' + String(error?.message ?? error));
  }
}
/**
 * 自动抓取：模型在消息里写了 :::decisions 块 ⇒ 插件自己把它变成待拍项。
 *
 * 这是「装完即用」的最后一环：人不必要求 agent 调工具，agent 也不必记得调 ——
 * 只要它按插件自带的系统提示写那段块，条目就会出现。
 *
 * 边界（比自动收口更窄）：只解析 assistant 消息里的 :::decisions 块，
 * 块外文本一律不读、不存、不外传。可 autoCapture:false 关掉。
 */
const CAPTURE_PROMPT = [
  '当你要人拍板时，除了在对话里提问，还要在消息末尾附一段机器可读块，插件会把它变成看板条目：',
  '',
  ':::decisions',
  '{"kind":"choice","title":"一句话说明要拍什么","question":"为什么需要拍","options":[{"key":"a","label":"方案甲","cost":"代价甲"},{"key":"b","label":"方案乙","cost":"代价乙"}],"recommended":"a","impact":["影响"],"quote":"人的原话"}',
  ':::',
  '',
  '规则：一条消息可以有多块；title 必填；「要不要」型把 options 写成空数组（看板会给是/否）；',
  '块外仍然正常向人解释，不要用别的格式写决策。'
].join('\n');

/**
 * 服务可能在 apply 之后才就绪（cordis 的加载顺序）。
 * 用 ctx.inject 等它就绪；假 ctx（测试）没有 inject 时退回 ctx.get 直接试一次。
 * 返回是否已安排注册（不代表服务可用）。
 */
function whenService(ctx, name, callback, log) {
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject([name], (scope) => {
        callback(scope);
      });
      return true;
    }
  } catch (error) {
    log('warn', '[dsh-decisions-board] 等待服务 ' + name + ' 失败：' + String(error?.message ?? error));
  }
  const owner = ctx;
  const service = (() => {
    try {
      return owner.get(name);
    } catch {
      return undefined;
    }
  })();
  if (service === undefined) return false;
  callback(owner);
  return true;
}
function registerCapturePrompt(owner, settings, log) {
  if (settings?.autoCapture === false) return;
  const registered = whenService(owner, 'systemPrompt', (scope) => {
    let prompt;
    try {
      prompt = scope.get('systemPrompt');
    } catch {
      prompt = undefined;
    }
    if (prompt === undefined || typeof prompt.section !== 'function') {
      log('warn', '[dsh-decisions-board] systemPrompt 服务不可用：模型不会知道 :::decisions 格式（工具仍可手动 add）');
      return;
    }
    try {
      const dispose = prompt.section({
        name: 'dsh-decisions-board/capture',
        order: 8000,
        text: CAPTURE_PROMPT,
        // 不允许插值：块里的 JSON 花括号不能交给变量解析器
        interpolate: false
      });
      if (typeof scope.effect === 'function' && typeof dispose === 'function') {
        scope.effect(() => dispose, 'dsh-decisions-board: capture prompt');
      }
      log('info', '[dsh-decisions-board] 已注入 systemPrompt 段（:::decisions 捕获协议）');
    } catch (error) {
      log('warn', '[dsh-decisions-board] 注入 systemPrompt 段失败：' + String(error?.message ?? error));
    }
  }, log);
  if (!registered) {
    log('warn', '[dsh-decisions-board] 没等到 systemPrompt 服务：模型不会知道 :::decisions 格式');
  }
}

async function captureFromAssistant(settings, session, event, seen, log) {
  const blocks = Array.isArray(event?.data?.message?.content) ? event.data.message.content : [];
  const text = blocks
    .filter((block) => block !== null && block !== undefined && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  const chunks = extractDecisionBlocks(text);
  if (chunks.length === 0) return;
  const file = fileForSession(settings, session);
  if (file === undefined) return;
  const read = await readDoc(file);
  const rawDoc = read.raw !== null && typeof read.raw === 'object' ? read.raw : { version: 1, session: '', items: [] };
  if (!Array.isArray(rawDoc.items)) rawDoc.items = [];
  const ids = read.doc.items.map((item) => item.id);
  const existing = new Set(read.doc.items.map((item) => item.title + '\u0000' + item.question));
  const added = [];
  for (const chunk of chunks) {
    let draft;
    try {
      draft = JSON.parse(chunk);
    } catch (error) {
      log('warn', '[dsh-decisions-board] :::decisions 块不是合法 JSON，已跳过：' + String(error?.message ?? error));
      continue;
    }
    const key = (session?.header?.id ?? '') + '\u0000' + JSON.stringify(draft);
    if (seen.has(key)) continue;
    let item;
    try {
      item = composePendingItem(draft, ids);
    } catch (error) {
      seen.add(key);
      log('warn', '[dsh-decisions-board] :::decisions 块不完整，已跳过：' + String(error?.message ?? error));
      continue;
    }
    const fingerprint = item.title + '\u0000' + item.question;
    if (existing.has(fingerprint)) {
      seen.add(key);
      continue;
    }
    const check = normalizeDoc({ version: 1, session: read.doc.session, items: [item] });
    const problems = check.problems.filter((entry) => entry.startsWith(item.id));
    if (problems.length > 0) {
      seen.add(key);
      log('warn', '[dsh-decisions-board] :::decisions 块被归一化拒绝：' + problems.join('；'));
      continue;
    }
    rawDoc.items.push(item);
    ids.push(item.id);
    existing.add(fingerprint);
    seen.add(key);
    added.push(item.id);
  }
  if (added.length === 0) return;
  await writeDoc(file, rawDoc);
  log('info', '[dsh-decisions-board] 按 assistant 消息自动新增：' + added.join(', ') + ' -> ' + file);
}

/** 订阅 assistant/message（settings.autoCapture === false 时整体关掉）。 */
function registerAutoCapture(ctx, settings, log) {
  if (settings?.autoCapture === false) {
    log('info', '[dsh-decisions-board] autoCapture 已关闭：只有显式调用 action=add 才会新增条目');
    return;
  }
  const seen = new Set();
  try {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'assistant/message') return;
      Promise.resolve()
        .then(() => captureFromAssistant(settings, session, event, seen, log))
        .catch((error) => log('warn', '[dsh-decisions-board] 自动新增失败：' + String(error?.message ?? error)));
    });
    log('info', '[dsh-decisions-board] 自动新增已开启（session/event: assistant/message + :::decisions）');
  } catch (error) {
    log('warn', '[dsh-decisions-board] 订阅 assistant/message 失败：' + String(error?.message ?? error));
  }
}
/**
 * @param ctx - 宿主插件上下文（需 connection / sandboxPolicy）。
 * @param config - cordis.patch.yml 里的 config（可选 file）。
 */
export function apply(ctx, config) {
  /** cordis 两种传参都见过（apply 的第二个参数 / ctx.config），两边都认。 */
  const settings = (() => {
    if (config !== undefined && config !== null) return config;
    try {
      return ctx?.config ?? {};
    } catch {
      return {};
    }
  })();
  const log = (level, message) => {
    try {
      ctx?.logger?.[level]?.(message);
    } catch {
      // 宿主没有 logger 不是错误。
    }
  };
  const routes = [
    { path: '/api/decisions-board/state', methods: ['GET'], handle: handleState },
    { path: '/api/decisions-board/decide', methods: ['POST'], handle: handleDecide }
  ];
  for (const route of routes) {
    try {
      ctx.connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: (request) => route.handle(ctx, settings, request, log)
      });
    } catch (error) {
      // 一条路由失败不能连累另一条；但必须吭声（不能静默装饰）。
      log('warn', '[dsh-decisions-board] 注册 ' + route.path + ' 失败：' + String(error?.message ?? error));
    }
  }
  registerTool(ctx, settings, log);
  registerAutoSettle(ctx, settings, log);
  registerCapturePrompt(ctx, settings, log);
  registerAutoCapture(ctx, settings, log);
  log('info', '[dsh-decisions-board] 已挂载：/' + STATE_PATH + ' , /' + DECIDE_PATH);
}