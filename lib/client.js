
/** 决策看板：会话区右上角的入口 + 右侧抽屉。由 tools/build-client.mjs 生成，勿手改。 */
window.__ModuleLoader__.load({
	id: 'dsh-decisions-board',
	factory: (require) => {
		const React = require('react');

// ── 内联 src/model.js ────────────────────────────────────────────────────────
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

const KIND_LABELS = {
  caliber: '标准',
  scope: '范围',
  contract: '约定',
  priority: '优先级',
  choice: '二选一'
};

const STATUS_LABELS = {
  pending: '待拍',
  filled: '已回填',
  decided: '已定',
  deferred: '后置',
  cancelled: '取消'
};

const KINDS = Object.keys(KIND_LABELS);
const STATUSES = Object.keys(STATUS_LABELS);

/** 缺代价时卡片上必须出现的字，不许静默省略（缺省不许静默省略）。 */
const MISSING_COST_TEXT = '未给代价';

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
function normalizeDoc(raw) {
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
        note: text(entry.decided.note, ''),
        // 「人自己点手动关闭」与「选了某个选项」的区别只在这里。
        // 这是手写字段清单（§1.10 的固定产地）：漏了它，读一次盘 manual 就没了，
        // 手动关闭的条目会退化成一个空标签 —— 所以 tests/model.test.mjs 有一条专门的往返断言。
        manual: entry.decided.manual === true
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
function normalizeDecisionText(value) {
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
function decisionKey(input) {
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
function findDuplicate(items, draft) {
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
function fillMissingFields(item, draft) {
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
function pendingItems(doc) {
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
function openItems(doc) {
  return doc.items.filter((item) => item.status === 'pending' || item.status === 'filled');
}

/**
 * 已定条目，最近 n 条。
 * 「最近」按 decided.at 排；同一时间戳或缺失时间戳时保持文件顺序，保证结果稳定可复现。
 */
function decidedItems(doc, limit) {
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
function itemView(item) {
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
  // 手动关闭 = 记了 manual，或者 value 为空（老数据没有 manual 标记，也按手动关闭显示）。
  // 不加这条兜底的话，卡片会渲染成「✓ 已定 」后面什么都没有。
  const decidedManual = item.decided !== null && (item.decided.manual === true || item.decided.value === '');
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
      manual: decidedManual,
      valueLabel: decidedManual
        ? '手动关闭'
        : (decidedOption === null
          ? (DECIDED_YES_NO[item.decided.value] ?? item.decided.value.toUpperCase())
          : decidedOption.keyLabel),
      label: decidedOption === null ? '' : decidedOption.label
    }
  };
}

/** 整份文档的展示模型。 */
function buildView(doc, decidedLimit) {
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
function composeNextDraft(currentDraft, sentence) {
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
function endpointUrl(base, kind, sessionId) {
  const query = typeof sessionId === 'string' && sessionId !== ''
    ? '?sessionId=' + encodeURIComponent(sessionId)
    : '';
  return base + kind + query;
}

/** 角标文案（0 条时说「待拍 0」，而不是消失 —— 人仍要能点开看已定）。 */
function badgeLabel(view) {
  const base = '待拍 ' + view.pendingCount;
  return view.filledCount > 0 ? base + ' · 待发 ' + view.filledCount : base;
}

/**
 * 回填输入框的那一句话。
 * 例：Q-11 选 A（扩阈值）；无选项的条目：Q-13 选 是。
 */
function composeFill(item, value) {
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
function settleSentence(item, value) {
  return '已定：' + composeFill(item, value);
}

/**
 * 手动关闭的复述句：已定：Q-16（手动关闭）—— 刻意不写成「选 X」。
 *
 * 为什么需要这条路径：人已经在对话里把答案说了，但插件没认出来
 * （措辞不是「Q-16 选 A」，或者人干脆没走回填、直接自己打的字）。
 * 这时条目会一直挂在待拍里，越积越多 ⇒ 板子失去可信度，人就不再看了。
 * 给人一个自己收口的按钮，比让插件去「猜」安全得多：猜错会把没定的当已定，
 * 而手动关闭只会少一条提醒，并且留下 by/at/manual 三个标记可追溯。
 */
function dismissSentence(item) {
  return '已定：' + item.id + '（手动关闭）';
}

/**
 * 把一次决定「原地」写进**原始解析对象**（不是 normalize 后的副本）。
 *
 * 为什么必须两套：normalizeDoc 只保留认识的字段，若拿它整体覆盖写盘，
 * 人手加的自定义字段（或未来版本的字段）会被静默丢掉 —— 而这个文件的设计前提就是「人能看、能手改」。
 * ⇒ 校验用 normalize 的结果，写盘用 raw。
 */
function applyDecisionToRaw(raw, patch) {
  const at = typeof patch.at === 'string' && patch.at !== '' ? patch.at : new Date().toISOString();
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const target = items.find((item) => item !== null && typeof item === 'object' && item.id === patch.id);
  if (target === undefined) throw new Error('unknown decision id: ' + String(patch.id));
  // 手动关闭：直接 decided，不记选项。manual 标记必须写盘 ——
  // 少了它，这条和「选了某个选项但 value 丢了」在文件里长得一样，事后无法归因。
  if (patch.dismiss === true) {
    target.status = 'decided';
    target.decided = {
      value: '',
      at,
      by: typeof patch.by === 'string' && patch.by !== '' ? patch.by : 'user',
      note: typeof patch.note === 'string' ? patch.note : '',
      manual: true
    };
    return raw;
  }
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
function withDecision(doc, patch) {
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
 * 人点「手动关闭」：把条目落成 decided，但**不记任何选项**。
 *
 * 触发场景（用户实测提出）：人已经在对话里回答了，但插件没认出来 ——
 * 可能是措辞不含「Q-16 选 A」，也可能是人在别的地方答的。
 * 这时条目会永远挂在待拍里，而人除了手改 JSON 没有出口。
 *
 * 三条校验：
 *   1. id 必须存在（否则回 400，不静默改坏文件）；
 *   2. **不接受 value** —— 「关闭」不是一张选票，塞个值进来会让看板谎称定了某个方案；
 *   3. 已经 decided 的不重复写（幂等失败要显式报错，而不是覆盖掉原来的 by/at）。
 */
function withDismiss(doc, patch) {
  const at = typeof patch.at === 'string' && patch.at !== '' ? patch.at : new Date().toISOString();
  const index = doc.items.findIndex((item) => item.id === patch.id);
  if (index < 0) throw new Error('unknown decision id: ' + String(patch.id));
  const value = typeof patch.value === 'string' ? patch.value.trim() : '';
  if (value !== '') {
    throw new Error('dismiss does not take a value: ' + patch.id + '（关闭不等于选某个选项）');
  }
  const target = doc.items[index];
  if (target.status === 'decided') {
    throw new Error('decision ' + target.id + ' is already decided');
  }
  const next = {
    ...target,
    status: 'decided',
    decided: {
      value: '',
      at,
      by: typeof patch.by === 'string' && patch.by !== '' ? patch.by : 'user',
      note: typeof patch.note === 'string' ? patch.note : '',
      manual: true
    }
  };
  const items = doc.items.slice();
  items[index] = next;
  return { doc: { ...doc, items }, item: next, sentence: dismissSentence(next) };
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
function matchSettlement(text, item) {
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
function composePendingItem(draft, existingIds) {
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
function extractDecisionBlocks(text) {
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

// ── 内联 src/panel.js ───────────────────────────────────────────────────────
/**
 * 决策看板的界面实现（原生 DOM，无框架）。
 *
 * 为什么不用框架：同一个界面要跑在两个宿主里 ——
 *   1. 路径 A：DSH 客户端插件（React 只提供一个挂载点）；
 *   2. 本地预览：本机小页（纯 ESM 直接 import）。
 * 用原生 DOM 写一份，两边都是「把节点塞进容器」，不存在第二份实现。
 *
 * 只消费 model.js 的 view 对象（itemView/buildView 的产物），不读原始 JSON 字段。
 */



const STYLE_ID = 'dsh-decisions-board-style';

const CSS = `
.dshdb-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:18px;cursor:pointer}
.dshdb-trigger:hover{background:var(--dsw-alias-fill-l1,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#c9cdd4)}
.dshdb-trigger[data-pending="0"]{opacity:.6}
.dshdb-trigger[data-open="1"]{background:var(--dsw-alias-fill-l1,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#fff)}
.dshdb-glyph{font-size:13px;line-height:1}
.dshdb-count{font-variant-numeric:tabular-nums}
.dshdb-mask{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:2147483000}
.dshdb-drawer{position:fixed;top:0;right:0;height:100vh;width:min(420px,100vw);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#1f2126);color:var(--dsw-alias-label-primary,#f2f3f5);border-left:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.4));z-index:2147483001;font-size:13px;line-height:20px}
.dshdb-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12))}
.dshdb-head h2{margin:0;font-size:14px;font-weight:600;flex:1}
.dshdb-close{border:0;background:transparent;color:inherit;font-size:16px;cursor:pointer;padding:2px 6px;border-radius:6px}
.dshdb-close:hover{background:var(--dsw-alias-fill-l1,rgba(127,127,127,.16))}
.dshdb-body{overflow:auto;padding:10px 14px 24px;flex:1}
.dshdb-empty{margin:16px 0;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshdb-card{border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:10px;padding:10px 12px;margin:10px 0;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03))}
.dshdb-card[data-status="decided"]{opacity:.85}
.dshdb-card-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.dshdb-kind{flex:none;font-size:11px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-fill-l1,rgba(127,127,127,.18));color:var(--dsw-alias-label-secondary,#c9cdd4)}
.dshdb-title{font-weight:600}
.dshdb-id{color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}
.dshdb-question{margin:6px 0 0;color:var(--dsw-alias-label-secondary,#c9cdd4)}
.dshdb-advice{margin:6px 0 0;color:#f0b429}
.dshdb-options{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.dshdb-option{display:flex;align-items:flex-start;gap:8px}
.dshdb-pick{flex:none;min-width:30px;height:26px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.18));background:transparent;color:inherit;font-weight:600;cursor:pointer}
.dshdb-pick:hover:not([disabled]){background:var(--dsw-alias-fill-l1,rgba(127,127,127,.18))}
.dshdb-pick[disabled]{cursor:default;opacity:.55}
.dshdb-option-text{display:flex;flex-direction:column;gap:1px}
.dshdb-cost{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshdb-cost[data-missing="1"]{color:#e5484d}
.dshdb-foot{margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshdb-more{border:0;background:transparent;color:var(--dsw-alias-link,#4c9aff);cursor:pointer;padding:2px 0;font-size:12px}
.dshdb-impact{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 0;padding:0;list-style:none}
.dshdb-tag{font-size:11px;padding:1px 6px;border-radius:999px;background:rgba(240,180,41,.16);color:#f0b429}
.dshdb-detail{margin-top:8px;padding-top:8px;border-top:.5px dashed var(--dsw-alias-border-l1,rgba(255,255,255,.18));display:flex;flex-direction:column;gap:6px}
.dshdb-detail dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:12px}
.dshdb-detail dt{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshdb-detail dd{margin:0;overflow-wrap:anywhere}
.dshdb-quote{margin:0;padding:6px 8px;border-left:2px solid var(--dsw-alias-border-l1,rgba(255,255,255,.24));color:var(--dsw-alias-label-secondary,#c9cdd4);font-size:12px}
.dshdb-links{display:flex;flex-direction:column;gap:2px;font-size:12px}
.dshdb-linkref{color:var(--dsw-alias-link,#4c9aff);overflow-wrap:anywhere;text-align:left;background:transparent;border:0;padding:0;cursor:pointer;font:inherit}
.dshdb-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshdb-toast{position:absolute;left:14px;right:14px;bottom:12px;padding:8px 10px;border-radius:8px;background:rgba(64,160,90,.18);color:#7ee2a8;font-size:12px}
`;

function ensureStyle(doc) {
  if (doc.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
  const tag = doc.createElement('style');
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = CSS;
  doc.head.appendChild(tag);
}

function el(tag, className, children) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (children !== undefined) {
    for (const child of [].concat(children)) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return node;
}

/**
 * 创建一块看板（一个触发器 + 一个抽屉），DOM 由调用方提供挂载点。
 * @param options.onDecide (id, value) => Promise<void> 人点了某个选项
 * @param options.onConfirm (id, value) => Promise<string> 人点「我已发送」（filled → decided）
 * @param options.onDismiss (id) => Promise<string> 人点「手动关闭」（不记选项，直接 decided）
 * @param options.onLink (link) => void 可选：点链接（预览模式 打开新标签；插件里没有就只显示文字）
 * @param options.fillHint 回填成功后的提示文案
 */
function createBoard(options = {}) {
  // confirmingDismiss：正在等第二次点击的条目 id（手动关闭是两步，防误触）。
  const state = { view: null, open: false, expanded: new Set(), signature: null, confirmingDismiss: null };
  const doc = document;
  ensureStyle(doc);

  const count = el('span', 'dshdb-count', '待拍 0');
  const trigger = el('button', 'dshdb-trigger', [el('span', 'dshdb-glyph', '⚖'), count]);
  trigger.type = 'button';
  trigger.title = '待拍板（会话区右上角）';
  trigger.setAttribute('aria-haspopup', 'dialog');

  const title = el('h2', undefined, '待拍板');
  const closeButton = el('button', 'dshdb-close', '✕');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭');
  const head = el('div', 'dshdb-head', [title, closeButton]);
  const body = el('div', 'dshdb-body');
  const drawer = el('aside', 'dshdb-drawer', [head, body]);
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', '待拍板');
  const mask = el('div', 'dshdb-mask');

  function close() {
    state.open = false;
    trigger.dataset.open = '0';
    trigger.setAttribute('aria-expanded', 'false');
    mask.remove();
    drawer.remove();
  }

  function open() {
    if (state.open) return;
    state.open = true;
    trigger.dataset.open = '1';
    trigger.setAttribute('aria-expanded', 'true');
    doc.body.appendChild(mask);
    doc.body.appendChild(drawer);
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  function renderCard(item, isDecided) {
    const card = el('article', 'dshdb-card');
    card.dataset.status = item.status;
    card.dataset.itemId = item.id;

    const head_ = el('div', 'dshdb-card-head', [
      el('span', 'dshdb-kind', item.kindLabel),
      el('span', 'dshdb-title', item.title),
      el('span', 'dshdb-id', item.id)
    ]);
    card.appendChild(head_);
    if (item.question !== '') card.appendChild(el('p', 'dshdb-question', item.question));

    let confirmButton = null;
    if (item.awaitingSend === true) {
      // 已回填但没确认送达 —— 必须显式留在清单里，并给一个「我发过了」的出口。
      const decided = item.decided;
      card.appendChild(el('p', 'dshdb-advice', '✎ 已回填 ' + decided.valueLabel + (decided.label === '' ? '' : '（' + decided.label + '）') + ' —— 等你按回车'));
      confirmButton = el('button', 'dshdb-more', '我已发送，标记为已定');
      confirmButton.type = 'button';
      confirmButton.setAttribute('data-action', 'confirm');
      confirmButton.addEventListener('click', () => {
        Promise.resolve(options.onConfirm?.(item.id, decided.value)).then((sentence) => {
          showFillHint(typeof sentence === 'string' && sentence !== '' ? sentence : '已标记为已定');
        }).catch((error) => {
          showFillHint('标记失败：' + String(error?.message ?? error));
        });
      });
    } else if (isDecided) {
      const decided = item.decided;
      card.appendChild(el('p', 'dshdb-advice', '✓ 已定 ' + decided.valueLabel + (decided.label === '' ? '' : '（' + decided.label + '）')));
      // 手动关闭不是选票：显式说明它只表示「这条不用再等」，免得后人把它读成「定了某个方案」。
      if (decided.manual === true) {
        card.appendChild(el('p', 'dshdb-note', '人工关闭：只表示这条不用再等，没记选项。'));
      }
      if (decided.note !== '') card.appendChild(el('p', 'dshdb-note', '备注：' + decided.note));
      if (decided.by !== '' || decided.at !== '') {
        card.appendChild(el('p', 'dshdb-note', '由 ' + (decided.by === '' ? '（未记）' : decided.by) + ' 于 ' + (decided.at === '' ? '（未记时间）' : decided.at)));
      }
    } else if (item.recommendedLabel !== '') {
      card.appendChild(el('p', 'dshdb-advice', '建议 ' + item.recommendedLabel));
    }

    // 「要不要」型（作者没写 options）也会到这里：model 会给合成的是/否，照样能点。
    if (item.defaultedOptions === true) {
      card.appendChild(el('p', 'dshdb-note', '该条没给选项 —— 默认按「是 / 否」拍。'));
    }
    if (item.options.length > 0) {
      const list = el('ul', 'dshdb-options');
      for (const option of item.options) {
        const pick = el('button', 'dshdb-pick', option.keyLabel);
        pick.type = 'button';
        pick.disabled = isDecided;
        pick.setAttribute('data-option-key', option.key);
        pick.addEventListener('click', () => {
          if (isDecided) return;
          Promise.resolve(options.onDecide?.(item.id, option.key)).then(() => {
            showFillHint();
          }).catch((error) => {
            showFillHint('回填失败：' + String(error?.message ?? error));
          });
        });
        const text = el('div', 'dshdb-option-text', [el('span', undefined, option.label)]);
        // 合成选项没有代价可显示 —— 别用红字「未给代价」冤枉作者。
        if (option.synthetic !== true) {
          const costNode = el('span', 'dshdb-cost', option.costMissing ? MISSING_COST_TEXT : option.cost);
          if (option.costMissing) costNode.dataset.missing = '1';
          text.appendChild(costNode);
        }
        list.appendChild(el('li', 'dshdb-option', [pick, text]));
      }
      card.appendChild(list);
    }

    if (item.impact.length > 0) {
      const tags = el('ul', 'dshdb-impact');
      for (const entry of item.impact) tags.appendChild(el('li', 'dshdb-tag', entry));
      card.appendChild(tags);
    }

    const more = el('button', 'dshdb-more', state.expanded.has(item.id) ? '收起原委 ▴' : '展开原委 ▾');
    more.type = 'button';
    more.addEventListener('click', () => {
      if (state.expanded.has(item.id)) state.expanded.delete(item.id);
      else state.expanded.add(item.id);
      renderBody();
    });

    const foot = [];
    if (confirmButton !== null) foot.push(confirmButton);
    // 手动关闭：只给还没定的条目。
    // 用途是「人已经在对话里答了，但插件没认出来」—— 只填不发的红线在这里依然成立：
    // 关掉条目**不会**往输入框写任何字、也不会发送，它只改这条决策的状态。
    if (!isDecided) {
      const pending = state.confirmingDismiss === item.id;
      const dismiss = el('button', 'dshdb-more', pending ? '确认关闭？（它不会发消息）' : '手动关闭');
      dismiss.type = 'button';
      dismiss.setAttribute('data-action', 'dismiss');
      dismiss.setAttribute('data-confirming', pending ? '1' : '0');
      dismiss.addEventListener('click', () => {
        // 两步：第一次只把按钮变成「确认关闭？」，避免一次误点把还在等人拍板的条目关掉。
        if (!pending) {
          state.confirmingDismiss = item.id;
          renderBody();
          return;
        }
        state.confirmingDismiss = null;
        Promise.resolve(options.onDismiss?.(item.id)).then((sentence) => {
          showFillHint(typeof sentence === 'string' && sentence !== '' ? sentence : '已手动关闭：' + item.id);
        }).catch((error) => {
          showFillHint('关闭失败：' + String(error?.message ?? error));
          renderBody();
        });
      });
      foot.push(dismiss);
    }
    foot.push(more);
    card.appendChild(el('div', 'dshdb-foot', foot));

    if (state.expanded.has(item.id)) {
      const detail = el('div', 'dshdb-detail');
      const dl = el('dl');
      const put = (term, value) => {
        if (value === '' || value === null || value === undefined) return;
        dl.appendChild(el('dt', undefined, term));
        dl.appendChild(el('dd', undefined, String(value)));
      };
      put('问题', item.question);
      put('建议', item.recommendedLabel);
      put('影响', item.impact.join('、'));
      if (item.options.some((option) => option.synthetic !== true)) {
        put('代价', item.options.filter((option) => option.synthetic !== true).map((option) => option.keyLabel + ' ' + (option.costMissing ? MISSING_COST_TEXT : option.cost)).join(' / '));
      }
      put('轮次', item.turn === null ? '' : '第 ' + item.turn + ' 轮');
      put('锚点', item.anchor);
      detail.appendChild(dl);
      if (item.quote !== '') detail.appendChild(el('blockquote', 'dshdb-quote', '“' + item.quote + '”'));
      if (item.links.length > 0) {
        const links = el('div', 'dshdb-links');
        for (const link of item.links) {
          if (typeof options.onLink === 'function') {
            const button = el('button', 'dshdb-linkref', link);
            button.type = 'button';
            button.addEventListener('click', () => options.onLink(link));
            links.appendChild(button);
          } else {
            links.appendChild(el('span', 'dshdb-linkref', link));
          }
        }
        detail.appendChild(links);
      }
      card.appendChild(detail);
    }
    return card;
  }

  function showFillHint(message) {
    const existing = drawer.querySelector('.dshdb-toast');
    if (existing !== null) existing.remove();
    const toast = el('div', 'dshdb-toast', message ?? options.fillHint ?? '已回填输入框 —— 按回车才发送');
    drawer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function renderBody() {
    body.textContent = '';
    const view = state.view;
    if (view === null) {
      body.appendChild(el('p', 'dshdb-empty', '还没有读到 decisions.json。'));
      return;
    }
    if (view.pending.length === 0) {
      body.appendChild(el('p', 'dshdb-empty', '没有待拍项。已定的留在下面。'));
    } else {
      for (const item of view.pending) body.appendChild(renderCard(item, false));
    }
    const decidedHead = el('h3', 'dshdb-note', '已定（最近 ' + view.decided.length + '）');
    decidedHead.style.margin = '18px 0 4px';
    body.appendChild(decidedHead);
    if (view.decided.length === 0) body.appendChild(el('p', 'dshdb-empty', '暂无已定条目。'));
    for (const item of view.decided) body.appendChild(renderCard(item, true));
  }

  trigger.addEventListener('click', toggle);
  closeButton.addEventListener('click', close);
  mask.addEventListener('click', close);
  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  return {
    /** 挂到会话区右上角的容器里。 */
    attachTrigger(host) {
      host.appendChild(trigger);
    },

    setView(view) {
      state.view = view;
      const label = badgeLabel(view);
      count.textContent = label;
      trigger.dataset.pending = String(view.pendingCount);
      trigger.setAttribute('aria-label', label + '，点开看待拍板');
      title.textContent = '待拍板 (' + view.pendingCount + ')';
      // 轮询每 1–2 秒来一次；数据没变就不要重建 DOM。
      // 否则按钮节点每次都被换掉，点得稍慢一点就落在已丢弃的节点上（实测撞到过），而且整屏会闪。
      const signature = JSON.stringify(view);
      if (signature === state.signature) return;
      state.signature = signature;
      renderBody();
    },
    /** 宿主在回填后覆盖提示文案（例如「已复制到剪贴板」）。 */
    setHint(message) {
      showFillHint(message);
    },
    open,
    close,
    get isOpen() {
      return state.open;
    },
    dispose() {
      close();
      trigger.remove();
    }
  };
}

// ── 浏览器半：把面板挂进会话区右上角 ────────────────────────────────────────
const API_BASE = (() => {
	try {
		return new URL('api/decisions-board/', document.baseURI).href;
	} catch {
		return '/api/decisions-board/';
	}
})();
const POLL_MS = 2000;

/**
 * 回填输入框。**只填不发**（本插件的红线：只填不发）。
 * inputActions 来自 ui-session 的会话标准 props（dsh-client-ui-conversation 的
 * ctx.uiSession.provide({ props: ['inputActions'] }) 发布），动作面见 SessionInputShell.actions。
 */
async function fillComposer(inputActions, text, currentDraft) {
	if (inputActions !== undefined && inputActions !== null) {
		// ⚠️ 顺序是刻意的：setDraft 在前。
		// 实测（dsh-voice-plus）会猴补丁 inputActions.insertText，把任何调用当成语音转写，
		// 先跑 LLM "校对" 再延迟写回 —— 于是我们的句子被模型改写、甚至因 span 过期而丢失。
		// setDraft 没人劫持，且只改草稿不发消息。
		if (typeof inputActions.setDraft === 'function') {
			inputActions.setDraft(composeNextDraft(currentDraft, text));
			return 'draft';
		}
		if (typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
			const span = inputActions.captureInsertion();
			if (inputActions.insertText(text, span) === true) return 'insert';
		}
	}
	try {
		await navigator.clipboard.writeText(text);
		return 'clipboard';
	} catch {
		return 'none';
	}
}

const FILL_HINT = {
	insert: '已填入输入框 —— 按回车才发送',
	draft: '已并入输入框 —— 按回车才发送',
	clipboard: '输入框接口不可用，已复制到剪贴板',
	none: '无法写入输入框，请手动抄写'
};

function DecisionsBadge(props) {
	const hostRef = React.useRef(null);
	const sessionId = props.sessionId;
	// 当前草稿：会话标准 hook（ui-session 发布的 hooks.input）。
	// 用它算「整段草稿应该是什么」，而不是让 insertText 往光标处插 —— 见 fillComposer 的注释。
	const currentDraft = typeof props.useInput === 'function'
		? props.useInput((input) => (input === undefined || input === null ? '' : input.draft ?? ''))
		: '';
	const draftRef = React.useRef(currentDraft);
	draftRef.current = currentDraft;

	React.useEffect(() => {
		const host = hostRef.current;
		if (host === null) return undefined;
		let disposed = false;
		let timer = null;

		const board = createBoard({
			fillHint: FILL_HINT.insert,
			onDecide: async (id, value) => {
				const response = await fetch(endpointUrl(API_BASE, 'decide', sessionId), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id, value, by: 'user' })
				});
				const result = await response.json();
				if (!result.ok) throw new Error(result.error ?? 'decide failed');
				board.setView(result.view);
				const mode = await fillComposer(props.inputActions, result.fill, draftRef.current);
				board.setHint(FILL_HINT[mode]);
			},
			// 人点「手动关闭」：人已经在对话里答了，但插件没认出来（措辞不是「Q-16 选 A」等）。
			// 这条路径**不填输入框、不发消息**，只把这条决策的状态关掉 —— 只填不发的红线不变。
			onDismiss: async (id) => {
				const response = await fetch(endpointUrl(API_BASE, 'decide', sessionId), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id, dismiss: true, by: 'user' })
				});
				const result = await response.json();
				if (!result.ok) throw new Error(result.error ?? 'dismiss failed');
				board.setView(result.view);
				// 复述句由宿主给（与 agent 收口同一份措辞），这里只负责显示。
				return result.sentence ?? ('已手动关闭：' + id);
			},
			// 人点「我已发送」：把 filled 提升为 decided —— 只有这一步才允许条目离开清单。
			onConfirm: async (id, value) => {
				const response = await fetch(endpointUrl(API_BASE, 'decide', sessionId), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id, value, by: 'user', confirm: true })
				});
				const result = await response.json();
				if (!result.ok) throw new Error(result.error ?? 'confirm failed');
				board.setView(result.view);
				// 复述句由宿主给（和 agent 收口时用的措辞同一份），这里只负责显示。
				return result.sentence ?? ('已定：' + result.fill);
			}
		});
		board.attachTrigger(host);

		const poll = async () => {
			try {
				const response = await fetch(endpointUrl(API_BASE, 'state', sessionId));
				const result = await response.json();
				if (disposed || !result.ok) return;
				board.setView(result.view);
			} catch {
				// 宿主暂时不可达时保持上一次的视图，不清空 —— 角标停在旧数字比闪成 0 好。
			}
		};
		void poll();
		timer = setInterval(poll, POLL_MS);

		return () => {
			disposed = true;
			if (timer !== null) clearInterval(timer);
			board.dispose();
		};
	}, [sessionId, props.inputActions]);

	return React.createElement('span', { ref: hostRef, style: { display: 'inline-flex' } });
}

function apply(ctx) {
	// 会话区右上角 = dsh-client-ui-conversation 声明的 conversation.session.header.actions（list）。
	// layout 只有 shell.leading / shell.bottom / shell.overlay，没有 header —— 见 docs/R1-slot-research.md。
	ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
		name: 'conversation.session.header.actions',
		id: 'decisions-board',
		order: 30
	}, DecisionsBadge));
}

return { apply, inject: ['slots'] };
	}
});

