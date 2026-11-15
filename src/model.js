/**
 * 决策看板的数据模型（纯函数，无 IO、无 DOM）。
 *
 * 同一份文件被三处使用：
 *   1. 宿主半 lib/index.js —— 读/写 decisions.json 时的校验与合并；
 *   2. 本地预览页（tools/serve.mjs + public/）—— 浏览器里直接 import；
 *   3. 客户端插件 lib/client.js —— 由 tools/build-client.mjs 内联进 bundle。
 * 因此这里不得出现 import/export 之外的模块语法，也不得依赖 node: 或 DOM。
 *
 * 唯一事实源是一份可 diff 的本地 JSON；本文件不依赖任何宿主 API，可脱离 DSH 单独测试。
 */

export const KIND_LABELS = {
  caliber: '标准',
  scope: '范围',
  contract: '约定',
  priority: '优先级',
  choice: '二选一'
};

export const STATUS_LABELS = {
  pending: '待拍',
  filled: '已回填',
  decided: '已定',
  deferred: '后置',
  cancelled: '取消'
};

const KINDS = Object.keys(KIND_LABELS);
const STATUSES = Object.keys(STATUS_LABELS);

/** 缺代价时卡片上必须出现的字，不许静默省略（缺省不许静默省略）。 */
export const MISSING_COST_TEXT = '未给代价';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function textList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * 归一化并校验一份 decisions.json。
 * @param raw - 已 JSON.parse 的任意值。
 * @returns {{doc: {version:number,session:string,items:Array}, problems: string[]}}
 *   doc 永远是可直接使用的形状；problems 记录被丢弃/被纠正的条目，便于人核对。
 */
export function normalizeDoc(raw) {
  const problems = [];
  const source = isPlainObject(raw) ? raw : {};
  if (!isPlainObject(raw)) problems.push('根节点不是对象，已按空文档处理');

  const version = Number.isFinite(source.version) ? source.version : 1;
  const session = text(source.session, '');
  const rawItems = Array.isArray(source.items) ? source.items : [];
  if (!Array.isArray(source.items)) problems.push('items 不是数组，已按空列表处理');

  const seen = new Set();
  const items = [];
  rawItems.forEach((entry, index) => {
    const at = 'items[' + index + ']';
    if (!isPlainObject(entry)) {
      problems.push(at + ' 不是对象，已丢弃');
      return;
    }
    const id = text(entry.id, '').trim();
    if (id === '') {
      problems.push(at + ' 缺少 id，已丢弃（id 是跨文件引用的锚点，不能省）');
      return;
    }
    if (seen.has(id)) {
      problems.push(at + ' 的 id "' + id + '" 重复，已丢弃（id 必须唯一）');
      return;
    }
    seen.add(id);

    let kind = text(entry.kind, 'choice');
    if (!KINDS.includes(kind)) {
      problems.push(id + ' 的 kind "' + kind + '" 不在枚举内，已按 choice 处理');
      kind = 'choice';
    }
    let status = text(entry.status, 'pending');
    if (!STATUSES.includes(status)) {
      problems.push(id + ' 的 status "' + status + '" 不在枚举内，已按 pending 处理');
      status = 'pending';
    }

    const options = [];
    if (Array.isArray(entry.options)) {
      entry.options.forEach((option, optionIndex) => {
        if (!isPlainObject(option)) {
          problems.push(id + '.options[' + optionIndex + '] 不是对象，已丢弃');
          return;
        }
        const key = text(option.key, '').trim();
        const label = text(option.label, '').trim();
        if (key === '' || label === '') {
          problems.push(id + '.options[' + optionIndex + '] 缺少 key 或 label，已丢弃');
          return;
        }
        // cost 允许缺失，但缺失会被 UI 显式标成「未给代价」。
        options.push({ key, label, cost: text(option.cost, '') });
      });
    }

    const recommended = text(entry.recommended, '');
    if (recommended !== '' && options.length > 0 && !options.some((option) => option.key === recommended)) {
      problems.push(id + ' 的 recommended "' + recommended + '" 不对应任何 option.key');
    }

    const source_ = isPlainObject(entry.source) ? entry.source : {};
    const decided = isPlainObject(entry.decided) && typeof entry.decided.value === 'string'
      ? {
        value: entry.decided.value,
        at: text(entry.decided.at, ''),
        by: text(entry.decided.by, ''),
        note: text(entry.decided.note, '')
      }
      : null;
    if (status === 'decided' && decided === null) {
      problems.push(id + ' 的 status 是 decided 但缺少 decided.value');
    }

    items.push({
      id,
      kind,
      status,
      title: text(entry.title, '').trim() === '' ? id : entry.title,
      question: text(entry.question, ''),
      options,
      recommended,
      impact: textList(entry.impact),
      links: textList(entry.links),
      source: {
        turn: Number.isFinite(source_.turn) ? source_.turn : null,
        anchor: text(source_.anchor, ''),
        quote: text(source_.quote, '')
      },
      decided
    });
  });

  return { doc: { version, session, items }, problems };
}

/**
 * 把一段决策文本归一化，用于「是不是同一件事」的比对。
 *
 * 为什么需要它：模型两次描述同一件事时，措辞几乎从不完全一致 ——
 * 多一个空格、全角冒号、句末加了句号，精确比对就漏了，于是看板上出现两条一样的决策。
 * ⇒ 去空白、去标点、统一全半角与大小写之后再比。
 */
export function normalizeDecisionText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[，。、；：！？,.．;:!?\-—_/\\|"'“”‘’（）()\[\]【】<>《》~`@#$%^&*+=]/gu, '');
}

/** 选项集合的指纹：只看 key，排序后拼接。没有选项时返回空串。 */
function optionKeySet(options) {
  if (!Array.isArray(options) || options.length === 0) return '';
  return options
    .map((option) => String(option?.key ?? '').trim())
    .filter((key) => key !== '')
    .sort()
    .join(',');
}

/** 一条决策的比对指纹：标题 + 问题（都已归一化）。 */
export function decisionKey(input) {
  return normalizeDecisionText(input?.title) + '\u0000' + normalizeDecisionText(input?.question);
}

/**
 * 判断「这条决策是不是已经在看板上」。
 *
 * 判定顺序（命中任一即视为同一条）：
 *   1. `id` 相同 —— 显式重复；
 *   2. 标题 + 问题（归一化后）完全相同；
 *   3. 标题相同，且选项 key 集合相同 —— 挡住「同一件事，但问题那段被改写」；
 *   4. 标题相同且两边都没有选项 —— 「要不要」型重复出现。
 *
 * ⚠️ 保守优先：宁可漏判（多出一条重复）也不误判（把两件不同的事合成一条）。
 * 所以「标题相同但选项不同」**不算**重复 —— 那多半是同一件事的两个不同方案列表。
 *
 * @returns {{item: object, reason: string} | null} 命中的既有条目与命中原因
 */
export function findDuplicate(items, draft) {
  const list = Array.isArray(items) ? items : [];
  const id = typeof draft?.id === 'string' ? draft.id.trim() : '';
  if (id !== '') {
    const sameId = list.find((item) => item.id === id);
    if (sameId !== undefined) return { item: sameId, reason: 'id' };
  }
  const key = decisionKey(draft);
  const exact = list.find((item) => decisionKey(item) === key);
  if (exact !== undefined) return { item: exact, reason: 'exact' };

  const title = normalizeDecisionText(draft?.title);
  if (title === '') return null;
  const sameTitle = list.filter((item) => normalizeDecisionText(item.title) === title);
  if (sameTitle.length === 0) return null;

  const draftOptions = optionKeySet(draft?.options);
  // 两边都没给选项（「要不要」型）：标题相同就是同一条。
  if (draftOptions === '') {
    const noOptions = sameTitle.find((item) => optionKeySet(item.options) === '');
    if (noOptions !== undefined) return { item: noOptions, reason: 'title' };
  }
  const sameOptions = sameTitle.find((item) => optionKeySet(item.options) === draftOptions);
  if (sameOptions !== undefined) return { item: sameOptions, reason: 'title+options' };
  return null;
}

/**
 * 把新草稿里「既有条目还空着」的字段补上 —— 只补空，不覆盖已有值。
 *
 * 用途：重复块不新增条目，但第一次可能没写全（比如漏了代价、漏了原话）；
 * 这时把缺的补进去，比丢掉更有用，也不会改动任何已经写好的字段。
 *
 * @returns {boolean} 是否真的改动了条目
 */
export function fillMissingFields(item, draft) {
  if (item === null || typeof item !== 'object' || draft === null || typeof draft !== 'object') return false;
  let changed = false;
  if (typeof item.question === 'string' && item.question.trim() === '' && typeof draft.question === 'string' && draft.question.trim() !== '') {
    item.question = draft.question;
    changed = true;
  }
  if (Array.isArray(item.options) && item.options.length === 0 && Array.isArray(draft.options) && draft.options.length > 0) {
    const options = draft.options
      .filter((option) => option !== null && option !== undefined && typeof option.key === 'string' && option.key.trim() !== ''
        && typeof option.label === 'string' && option.label.trim() !== '')
      .map((option) => ({ key: option.key.trim(), label: option.label.trim(), cost: typeof option.cost === 'string' ? option.cost : '' }));
    if (options.length > 0) {
      item.options = options;
      changed = true;
      const recommended = typeof draft.recommended === 'string' ? draft.recommended.trim() : '';
      if (recommended !== '' && (typeof item.recommended !== 'string' || item.recommended === '') && options.some((option) => option.key === recommended)) {
        item.recommended = recommended;
      }
    }
  }
  if (Array.isArray(item.impact) && item.impact.length === 0 && Array.isArray(draft.impact) && draft.impact.length > 0) {
    item.impact = draft.impact.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
    if (item.impact.length > 0) changed = true;
  }
  if (Array.isArray(item.links) && item.links.length === 0 && Array.isArray(draft.links) && draft.links.length > 0) {
    item.links = draft.links.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
    if (item.links.length > 0) changed = true;
  }
  const quote = typeof draft.quote === 'string' ? draft.quote.trim() : '';
  if (quote !== '' && item.source !== null && typeof item.source === 'object'
    && (typeof item.source.quote !== 'string' || item.source.quote.trim() === '')) {
    item.source.quote = quote;
    changed = true;
  }
  return changed;
}
/** 纯粹「还没人动过」的条目。 */
export function pendingItems(doc) {
  return doc.items.filter((item) => item.status === 'pending');
}

/**
 * 「还等着人动手」的条目 = pending + filled。
 *
 * ⚠️ filled（已回填、等你按回车）必须继续留在清单里。
 * 实测事故：点了选项 ⇒ 写 decided ⇒ 卡片从待拍消失，但回填被别的插件吞掉、消息根本没发出去，
 * 于是这条决策**静默丢失**（看板说已定，会话里从未出现）。
 * ⇒ 只有「人确认已发送」或 agent 看到回答后写入，才允许离开这份清单。
 */
export function openItems(doc) {
  return doc.items.filter((item) => item.status === 'pending' || item.status === 'filled');
}

/**
 * 已定条目，最近 n 条。
 * 「最近」按 decided.at 排；同一时间戳或缺失时间戳时保持文件顺序，保证结果稳定可复现。
 */
export function decidedItems(doc, limit) {
  const max = Number.isFinite(limit) ? limit : 5;
  const decided = doc.items.filter((item) => item.status === 'decided');
  return decided
    .map((item, index) => ({ item, index, at: item.decided?.at ?? '' }))
    .sort((left, right) => {
      if (left.at === right.at) return right.index - left.index;
      if (left.at === '') return 1;
      if (right.at === '') return -1;
      return left.at < right.at ? 1 : -1;
    })
    .slice(0, max)
    .map((entry) => entry.item);
}

/**
 * 没有选项的条目（「要不要」型）在 UI 上默认给「是 / 否」两个按钮。
 *
 * 依据：真实使用里很常见 ——「有些条目没有选项（只有一个『要不要』）
 * ⇒ options 允许为空数组，此时 UI 显示『是/否』」。空着不给按钮等于让人自己打字，
 * 那正是这个插件要消灭的动作。⇒ 合成两个选项，并用 synthetic 标出来，
 * 避免被当成「作者写了选项却没给代价」。
 */
const DEFAULT_OPTIONS = [
  { key: 'yes', keyLabel: '是', label: '要', cost: '', costMissing: false, synthetic: true },
  { key: 'no', keyLabel: '否', label: '不要', cost: '', costMissing: false, synthetic: true }
];

const DECIDED_YES_NO = { yes: '是', no: '否' };

/** 单条决策的展示模型（UI 只消费这个，不直接读原始字段）。 */
export function itemView(item) {
  const authored = item.options.map((option) => ({
    key: option.key,
    keyLabel: option.key.toUpperCase(),
    label: option.label,
    cost: option.cost,
    costMissing: option.cost.trim() === '',
    synthetic: false
  }));
  const defaultedOptions = authored.length === 0;
  const options = defaultedOptions ? DEFAULT_OPTIONS.map((option) => ({ ...option })) : authored;
  const recommendedOption = options.find((option) => option.key === item.recommended) ?? null;
  const decidedOption = item.decided === null
    ? null
    : options.find((option) => option.key === item.decided.value) ?? null;
  return {
    id: item.id,
    kind: item.kind,
    kindLabel: KIND_LABELS[item.kind] ?? item.kind,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status] ?? item.status,
    title: item.title,
    question: item.question,
    options,
    hasOptions: options.length > 0,
    defaultedOptions,
    awaitingSend: item.status === 'filled',
    recommended: item.recommended,
    recommendedLabel: recommendedOption === null
      ? (item.recommended === '' ? '' : item.recommended.toUpperCase())
      : recommendedOption.keyLabel + ' ' + recommendedOption.label,
    impact: item.impact,
    links: item.links,
    turn: item.source.turn,
    anchor: item.source.anchor,
    quote: item.source.quote,
    decided: item.decided === null ? null : {
      ...item.decided,
      valueLabel: decidedOption === null
        ? (DECIDED_YES_NO[item.decided.value] ?? item.decided.value.toUpperCase())
        : decidedOption.keyLabel,
      label: decidedOption === null ? '' : decidedOption.label
    }
  };
}

/** 整份文档的展示模型。 */
export function buildView(doc, decidedLimit) {
  const pending = openItems(doc).map(itemView);
  const decided = decidedItems(doc, decidedLimit).map(itemView);
  return {
    session: doc.session,
    pendingCount: pending.length,
    filledCount: pending.filter((item) => item.awaitingSend === true).length,
    pending,
    decided,
    total: doc.items.length
  };
}

/**
 * 把「这一句」并进当前草稿：同一条决策已有行就**替换那一行**，否则追加新行。
 *
 * 为什么不直接插入：`inputActions.insertText` 是**会话共享对象**上的方法，
 * 别的插件（实测：dsh-voice-plus）会把它猴补丁成「转写 → LLM 校对 → 延迟写回」，
 * 于是我们的句子被当成语音转写，被模型改写、还可能因 span 过期而丢掉。
 * ⇒ 填充走未被劫持的 `setDraft`，由我们自己算好「整段草稿应该是什么」。
 *
 * @param currentDraft - 当前草稿（可能带用户已经打好的字）
 * @param sentence - 要并入的那一句，例如 Q-3 选 A（先发布）
 */
export function composeNextDraft(currentDraft, sentence) {
  const current = typeof currentDraft === 'string' ? currentDraft : '';
  const line = typeof sentence === 'string' ? sentence.trim() : '';
  if (line === '') return current;
  const id = line.split(/\s+/u)[0];
  const lines = current === '' ? [] : current.split('\n');
  const index = lines.findIndex((entry) => entry.trim().startsWith(id + ' ') || entry.trim() === id);
  if (index >= 0) {
    lines[index] = line;
    return lines.join('\n');
  }
  if (current.trim() === '') return line;
  return current.replace(/\s+$/u, '') + '\n' + line;
}

/**
 * 组装 /api/decisions-board/<kind> 的 URL。
 *
 * ⚠️ sessionId 不是装饰：宿主靠它反查「这条会话的工作目录」，缺了就直接 400
 * （cannot resolve a workspace directory）。0.1.1 的 decide 忘了带，人点了 [A] 只看到报错 ——
 * 所以两个端点共用这一个函数，并有单测守着。
 */
export function endpointUrl(base, kind, sessionId) {
  const query = typeof sessionId === 'string' && sessionId !== ''
    ? '?sessionId=' + encodeURIComponent(sessionId)
    : '';
  return base + kind + query;
}

/** 角标文案（0 条时说「待拍 0」，而不是消失 —— 人仍要能点开看已定）。 */
export function badgeLabel(view) {
  const base = '待拍 ' + view.pendingCount;
  return view.filledCount > 0 ? base + ' · 待发 ' + view.filledCount : base;
}

/**
 * 回填输入框的那一句话。
 * 例：Q-11 选 A（扩阈值）；无选项的条目：Q-13 选 是。
 */
export function composeFill(item, value) {
  const view = itemView(item);
  const normalized = typeof value === 'string' ? value.trim() : '';
  const option = view.options.find((candidate) => candidate.key.toLowerCase() === normalized.toLowerCase());
  if (option !== undefined) {
    // 合成的「是/否」不写括号后缀：Q-16 选 是（要）读起来别扭，而且没信息量。
    return option.synthetic === true
      ? view.id + ' 选 ' + option.keyLabel
      : view.id + ' 选 ' + option.keyLabel + '（' + option.label + '）';
  }
  if (normalized === 'yes') return view.id + ' 选 是';
  if (normalized === 'no') return view.id + ' 选 否';
  return view.id + ' 选 ' + (normalized === '' ? '（空）' : normalized);
}

/** 收口时的复述句：已定：Q-11 选 A（扩阈值）。人点「我已发送」和 agent 收口都用它，措辞才一致。 */
export function settleSentence(item, value) {
  return '已定：' + composeFill(item, value);
}

/**
 * 把一次决定「原地」写进**原始解析对象**（不是 normalize 后的副本）。
 *
 * 为什么必须两套：normalizeDoc 只保留认识的字段，若拿它整体覆盖写盘，
 * 人手加的自定义字段（或未来版本的字段）会被静默丢掉 —— 而这个文件的设计前提就是「人能看、能手改」。
 * ⇒ 校验用 normalize 的结果，写盘用 raw。
 */
export function applyDecisionToRaw(raw, patch) {
  const at = typeof patch.at === 'string' && patch.at !== '' ? patch.at : new Date().toISOString();
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const target = items.find((item) => item !== null && typeof item === 'object' && item.id === patch.id);
  if (target === undefined) throw new Error('unknown decision id: ' + String(patch.id));
  target.status = patch.confirm === true ? 'decided' : 'filled';
  target.decided = {
    value: patch.value,
    at,
    by: typeof patch.by === 'string' && patch.by !== '' ? patch.by : 'user',
    note: typeof patch.note === 'string' ? patch.note : ''
  };
  return raw;
}

/** 未知 id 时会抛错，调用方据此回 400 而不是静默改坏文件。 */
export function withDecision(doc, patch) {
  const at = typeof patch.at === 'string' && patch.at !== '' ? patch.at : new Date().toISOString();
  const index = doc.items.findIndex((item) => item.id === patch.id);
  if (index < 0) throw new Error('unknown decision id: ' + String(patch.id));
  const value = typeof patch.value === 'string' ? patch.value : '';
  if (value === '') throw new Error('decision value is required');
  const target = doc.items[index];
  if (target.options.length === 0) {
    // 「要不要」型只有两个合法答案，别让人把任意字符串塞进 decided.value。
    if (value !== 'yes' && value !== 'no') {
      throw new Error('decision value "' + value + '" must be yes or no for ' + target.id + ' (this item has no options)');
    }
  } else {
    const known = target.options.some((option) => option.key.toLowerCase() === value.toLowerCase());
    if (!known) {
      throw new Error('decision value "' + value + '" is not one of the options of ' + target.id);
    }
  }
  // 关键：默认只到 filled（已回填、待确认送达）。
  // 用户实测过：写 decided 后卡片立刻消失，而回填/发送失败时谁都不知道 —— 那就是静默丢板。
  const next = {
    ...target,
    status: patch.confirm === true ? 'decided' : 'filled',
    decided: {
      value,
      at,
      by: typeof patch.by === 'string' && patch.by !== '' ? patch.by : 'user',
      note: typeof patch.note === 'string' ? patch.note : ''
    }
  };
  const items = doc.items.slice();
  items[index] = next;
  return { doc: { ...doc, items }, item: next, fill: composeFill(next, value) };
}
/**
 * 从一段「人发的消息」里认出某条决策的答案。
 *
 * 为什么需要它：插件观测不到「人按了回车」。但宿主机侧有 session/event 钩子（user/message），
 * 于是可以靠「我们自己填进去的那句话」反查 —— 不需要项目宪法、不需要 skill、不需要 MCP。
 *
 * 容忍的形式（都要求 id 前面是行首或分隔符，避免 Q-1 命中 Q-11）：
 *   Q-11 选 A（扩阈值）   /   Q-11 选 A   /   Q-16 选 是   /   Q-16 选 否   /   Q-16 选 yes
 * 认不出或答案不合法时返回 null —— 宁可留在 filled 里让人看见，也不要猜。
 */
export function matchSettlement(text, item) {
  if (typeof text !== 'string' || text === '') return null;
  const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp('(?:^|[\\s，,。;；:：])' + escaped + '\\s*选\\s*([A-Za-z]+|是|否)', 'u');
  const hit = text.match(pattern);
  if (hit === null) return null;
  const raw = hit[1];
  if (raw === '是') return 'yes';
  if (raw === '否') return 'no';
  const key = raw.toLowerCase();
  if (item.options.length === 0) {
    return key === 'yes' || key === 'no' ? key : null;
  }
  return item.options.some((option) => option.key.toLowerCase() === key) ? key : null;
}
/**
 * 由一次调用构造一条新的 pending 条目（纯函数）。
 *
 * 为什么要有它：条目只能由「人」或「agent」写进文件；让 agent 手搓 JSON 会踩三个坑 ——
 * 路径猜错、id 撞车、字段写歪（后者会被 normalizeDoc 静默丢弃）。
 * 这里把「造条目」收敛成一次带校验的构造：id 可自动编号，字段只认白名单，缺失必填项直接抛错。
 *
 * @param draft - 调用方给的原始字段
 * @param existingIds - 该会话文件里已有的 id（用于自动编号与查重）
 * @returns 可直接 append 进 items 的条目对象（未归一化，交由 normalizeDoc 兜底）
 */
export function composePendingItem(draft, existingIds) {
  const input = draft !== null && typeof draft === 'object' ? draft : {};
  const ids = Array.isArray(existingIds) ? existingIds.map(String) : [];
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '') throw new Error('add 需要 title（一句话说明要人拍什么）');

  // id：显式给就查重；不给就按 Q-<n> 递增（避开已有编号）。
  let id = typeof input.id === 'string' ? input.id.trim() : '';
  if (id !== '') {
    if (ids.includes(id)) throw new Error('id 已存在：' + id);
  } else {
    let next = 1;
    for (const existing of ids) {
      const hit = /^Q-(\d+)$/u.exec(existing);
      if (hit !== null) next = Math.max(next, Number(hit[1]) + 1);
    }
    while (ids.includes('Q-' + next)) next += 1;
    id = 'Q-' + next;
  }

  const options = [];
  if (Array.isArray(input.options)) {
    input.options.forEach((option, index) => {
      const key = option !== null && typeof option === 'object' && typeof option.key === 'string' ? option.key.trim() : '';
      const label = option !== null && typeof option === 'object' && typeof option.label === 'string' ? option.label.trim() : '';
      if (key === '' || label === '') throw new Error('options[' + index + '] 需要 key 与 label');
      options.push({ key, label, cost: typeof option.cost === 'string' ? option.cost : '' });
    });
  }

  const recommended = typeof input.recommended === 'string' ? input.recommended.trim() : '';
  if (recommended !== '' && options.length > 0 && !options.some((option) => option.key === recommended)) {
    throw new Error('recommended 必须对应某个 options.key：' + recommended);
  }

  return {
    id,
    kind: typeof input.kind === 'string' && input.kind !== '' ? input.kind : 'choice',
    status: 'pending',
    title,
    question: typeof input.question === 'string' ? input.question : '',
    options,
    recommended,
    impact: Array.isArray(input.impact) ? input.impact.filter((entry) => typeof entry === 'string') : [],
    links: Array.isArray(input.links) ? input.links.filter((entry) => typeof entry === 'string') : [],
    source: {
      turn: Number.isFinite(input.turn) ? input.turn : null,
      anchor: typeof input.anchor === 'string' ? input.anchor : '',
      quote: typeof input.quote === 'string' ? input.quote : ''
    }
  };
}
/**
 * 从 assistant 的一段文本里抽出「决策块」。
 *
 * 约定格式（插件会通过 systemPrompt 段告诉模型）：
 *
 *   :::decisions
 *   {"kind":"choice","title":"…","options":[{"key":"a","label":"…","cost":"…"}]}
 *   :::
 *
 * 为什么坚持显式标记而不是"猜"：会话里到处是「A 还是 B」，猜就会污染看板。
 * 标记块是模型主动声明"这条要人拍板"的唯一可靠信号。
 *
 * @param text - assistant 消息里的纯文本
 * @returns 每块的 JSON 原文（已 trim），解析失败由调用方负责
 */
export function extractDecisionBlocks(text) {
  if (typeof text !== 'string' || text === '') return [];
  const blocks = [];
  const pattern = /:::decisions[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*:::/gu;
  let hit = pattern.exec(text);
  while (hit !== null) {
    const body = hit[1].trim();
    if (body !== '') blocks.push(body);
    hit = pattern.exec(text);
  }
  return blocks;
}
