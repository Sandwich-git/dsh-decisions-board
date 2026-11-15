import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MISSING_COST_TEXT,
  badgeLabel,
  buildView,
  applyDecisionToRaw,
  composeFill,
  composeNextDraft,
  extractDecisionBlocks,
  decidedItems,
  endpointUrl,
  itemView,
  matchSettlement,
  normalizeDoc,
  withDecision
} from '../src/model.js';

function doc(items, extra = {}) {
  return normalizeDoc({ version: 1, session: 's', items, ...extra }).doc;
}

test('normalizeDoc 丢弃缺 id / 重复 id，并记录原因', () => {
  const { doc: parsed, problems } = normalizeDoc({
    version: 1,
    session: 's',
    items: [
      { id: 'Q-1', title: 't' },
      { title: '没有 id' },
      { id: 'Q-1', title: '重复' },
      'not-an-object'
    ]
  });
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].id, 'Q-1');
  assert.equal(problems.length, 3);
  assert.ok(problems.some((entry) => entry.includes('缺少 id')));
  assert.ok(problems.some((entry) => entry.includes('重复')));
});

test('normalizeDoc 对未知 kind/status 回落到默认值而不是丢弃条目', () => {
  const { doc: parsed, problems } = normalizeDoc({
    version: 1,
    items: [{ id: 'Q-2', kind: 'whatever', status: 'nonsense' }]
  });
  assert.equal(parsed.items[0].kind, 'choice');
  assert.equal(parsed.items[0].status, 'pending');
  assert.equal(problems.length, 2);
});

test('options 的 cost 缺失时保留条目，交给 UI 显式说「未给代价」', () => {
  const view = buildView(doc([{
    id: 'Q-3',
    options: [{ key: 'a', label: '甲', cost: '两行代码' }, { key: 'b', label: '乙' }]
  }]));
  const card = view.pending[0];
  assert.equal(card.options[0].costMissing, false);
  assert.equal(card.options[1].costMissing, true);
  assert.equal(card.options[1].cost, '');
  assert.equal(MISSING_COST_TEXT, '未给代价');
});

test('options 为空数组时合成「是 / 否」两个可点选项（真实使用里很常见的一种形态）', () => {
  const view = buildView(doc([{ id: 'Q-4', options: [] }]));
  const card = view.pending[0];
  assert.equal(card.defaultedOptions, true, '要告诉 UI「这两个是默认给的」');
  assert.equal(card.hasOptions, true, '空 options 也必须能点');
  assert.deepEqual(card.options.map((option) => option.key), ['yes', 'no']);
  assert.deepEqual(card.options.map((option) => option.keyLabel), ['是', '否']);
  assert.equal(card.options.every((option) => option.synthetic === true), true);
  assert.equal(card.options.every((option) => option.costMissing === false), true, '合成选项不该被判「未给代价」');
});

test('空 options 的条目：composeFill 给「id 选 是」，decided 回显「是」，值只收 yes/no', () => {
  const parsed = doc([{ id: 'Q-16', options: [] }]);
  assert.equal(composeFill(parsed.items[0], 'yes'), 'Q-16 选 是');
  assert.equal(composeFill(parsed.items[0], 'no'), 'Q-16 选 否');
  const applied = withDecision(parsed, { id: 'Q-16', value: 'yes', at: '2026-11-15T20:00:00Z', by: 'someone' });
  assert.equal(applied.doc.items[0].decided.value, 'yes');
  assert.equal(itemView(applied.doc.items[0]).decided.valueLabel, '是');
  assert.throws(() => withDecision(parsed, { id: 'Q-16', value: 'a' }), /must be yes or no/);
});

test('recommended 指向不存在的 key 时记录问题但不改数据', () => {
  const { doc: parsed, problems } = normalizeDoc({
    version: 1,
    items: [{ id: 'Q-5', options: [{ key: 'a', label: 'A' }], recommended: 'z' }]
  });
  assert.equal(parsed.items[0].recommended, 'z');
  assert.ok(problems.some((entry) => entry.includes('recommended')));
});

test('待拍计数 = pending + filled；deferred/cancelled 不算', () => {
  const view = buildView(doc([
    { id: 'P-1' },
    { id: 'P-2' },
    { id: 'F-1', status: 'filled', decided: { value: 'a', at: '2026-01-01T00:00:00Z', by: 'someone' } },
    { id: 'D-1', status: 'decided', decided: { value: 'a', at: '2026-01-01T00:00:00Z', by: 'someone' } },
    { id: 'X-1', status: 'deferred' }
  ]));
  assert.equal(view.pendingCount, 3, 'pending 2 + filled 1');
  assert.equal(view.filledCount, 1);
  assert.equal(badgeLabel(view), '待拍 3 · 待发 1');
});

test('已定条目按 decided.at 倒序取最近 N 条，缺失时间戳排最后', () => {
  const parsed = doc([
    { id: 'D-1', status: 'decided', decided: { value: 'a', at: '2026-01-01T00:00:00Z', by: 'someone' } },
    { id: 'D-2', status: 'decided', decided: { value: 'a', at: '2026-03-01T00:00:00Z', by: 'someone' } },
    { id: 'D-3', status: 'decided', decided: { value: 'a', at: '2026-02-01T00:00:00Z', by: 'someone' } },
    { id: 'D-4', status: 'decided', decided: { value: 'a', at: '', by: 'someone' } }
  ]);
  assert.deepEqual(decidedItems(parsed, 3).map((item) => item.id), ['D-2', 'D-3', 'D-1']);
  assert.deepEqual(decidedItems(parsed, 10).map((item) => item.id), ['D-2', 'D-3', 'D-1', 'D-4']);
});

test('composeFill 产生「id 选 键（标签）」；无选项时给是/否', () => {
  const parsed = doc([{
    id: 'Q-11',
    options: [{ key: 'a', label: '扩阈值', cost: '要改接口' }, { key: 'b', label: '压缩描述' }]
  }]);
  assert.equal(composeFill(parsed.items[0], 'a'), 'Q-11 选 A（扩阈值）');
  assert.equal(composeFill(parsed.items[0], 'B'), 'Q-11 选 B（压缩描述）');
  const bare = doc([{ id: 'Q-16', options: [] }]).items[0];
  assert.equal(composeFill(bare, 'yes'), 'Q-16 选 是');
  assert.equal(composeFill(bare, 'no'), 'Q-16 选 否');
});

test('itemView 的 decided.valueLabel 能翻译回选项键', () => {
  const parsed = doc([{
    id: 'Q-12',
    status: 'decided',
    options: [{ key: 'a', label: '维持' }],
    decided: { value: 'a', at: '2026-01-01T00:00:00Z', by: 'someone', note: '已确认' }
  }]);
  const view = itemView(parsed.items[0]);
  assert.equal(view.decided.valueLabel, 'A');
  assert.equal(view.decided.label, '维持');
});

test('withDecision 是纯函数：写回 filled（不是 decided），不改原文档，并返回回填句', () => {
  const parsed = doc([{ id: 'Q-11', options: [{ key: 'a', label: '扩阈值' }] }]);
  const applied = withDecision(parsed, { id: 'Q-11', value: 'a', at: '2026-11-15T10:00:00Z', by: 'someone' });
  assert.equal(parsed.items[0].status, 'pending');
  assert.equal(parsed.items[0].decided, null);
  assert.equal(applied.doc.items[0].status, 'filled', '默认只到 filled —— 还要人按回车');
  assert.equal(applied.doc.items[0].decided.value, 'a');
  assert.equal(applied.doc.items[0].decided.at, '2026-11-15T10:00:00Z');
  assert.equal(applied.fill, 'Q-11 选 A（扩阈值）');
});

test('withDecision 拒绝未知 id 与非法选项值（不静默改坏文件）', () => {
  const parsed = doc([{ id: 'Q-11', options: [{ key: 'a', label: '扩阈值' }] }]);
  assert.throws(() => withDecision(parsed, { id: 'nope', value: 'a' }), /unknown decision id/);
  assert.throws(() => withDecision(parsed, { id: 'Q-11', value: 'zzz' }), /not one of the options/);
  assert.throws(() => withDecision(parsed, { id: 'Q-11', value: '' }), /value is required/);
});

test('endpointUrl 两个端点都带 sessionId（0.1.1 的 decide 漏了它 ⇒ 宿主 400）', () => {
  const base = 'http://127.0.0.1:1/api/decisions-board/';
  assert.equal(endpointUrl(base, 'state', 'S1'), base + 'state?sessionId=S1');
  assert.equal(endpointUrl(base, 'decide', 'S1'), base + 'decide?sessionId=S1');
  assert.equal(endpointUrl(base, 'decide', 'a b&c'), base + 'decide?sessionId=a%20b%26c');
  assert.equal(endpointUrl(base, 'state', undefined), base + 'state');
});

test('composeNextDraft：空草稿直接就是那一句；非空则并成新行', () => {
  assert.equal(composeNextDraft('', 'Q-11 选 A（扩阈值）'), 'Q-11 选 A（扩阈值）');
  assert.equal(composeNextDraft('  ', 'Q-11 选 A（扩阈值）'), 'Q-11 选 A（扩阈值）');
  assert.equal(composeNextDraft('先干这个', 'Q-11 选 A（扩阈值）'), '先干这个\nQ-11 选 A（扩阈值）');
  assert.equal(composeNextDraft('先干这个\n', 'Q-11 选 A（扩阈值）'), '先干这个\nQ-11 选 A（扩阈值）');
});

test('composeNextDraft：同一条决策改主意时替换那一行，不叠加矛盾指令', () => {
  const first = composeNextDraft('', 'Q-11 选 A（扩阈值）');
  const second = composeNextDraft(first, 'Q-11 选 B（压缩既有工具描述）');
  assert.equal(second, 'Q-11 选 B（压缩既有工具描述）');
  const mixed = composeNextDraft('别的说明', 'Q-11 选 A（扩阈值）');
  assert.equal(composeNextDraft(mixed, 'Q-11 选 B（压缩描述）'), '别的说明\nQ-11 选 B（压缩描述）');
});

test('写回默认只到 filled：条目仍算「等着人动手」，角标显示待发', () => {
  const parsed = doc([{ id: 'Q-11', options: [{ key: 'a', label: '扩阈值' }] }]);
  const applied = withDecision(parsed, { id: 'Q-11', value: 'a', at: '2026-11-15T10:00:00Z' });
  const view = buildView(applied.doc, 5);
  assert.equal(view.pendingCount, 1, 'filled 仍要出现在待拍里（静默丢板的反面）');
  assert.equal(view.filledCount, 1);
  assert.equal(view.pending[0].awaitingSend, true);
  assert.equal(badgeLabel(view), '待拍 1 · 待发 1');
  assert.equal(view.decided.length, 0, '还没进已定');
});

test('confirm=true 才落 decided：条目离开待拍、角标归一', () => {
  const parsed = doc([{ id: 'Q-11', options: [{ key: 'a', label: '扩阈值' }] }]);
  const filled = withDecision(parsed, { id: 'Q-11', value: 'a', at: '2026-11-15T10:00:00Z' });
  const decided = withDecision(filled.doc, { id: 'Q-11', value: 'a', at: '2026-11-15T10:00:00Z', confirm: true });
  assert.equal(decided.doc.items[0].status, 'decided');
  const view = buildView(decided.doc, 5);
  assert.equal(view.pendingCount, 0);
  assert.equal(view.filledCount, 0);
  assert.equal(badgeLabel(view), '待拍 0');
  assert.equal(view.decided.length, 1);
});

test('applyDecisionToRaw 同样按 confirm 决定状态（写盘不能比内存更激进）', () => {
  const raw = { version: 1, session: 's', items: [{ id: 'Q-1', status: 'pending', options: [{ key: 'a', label: '甲' }], extra: '保留' }] };
  applyDecisionToRaw(raw, { id: 'Q-1', value: 'a', at: '2026-11-15T10:00:00Z' });
  assert.equal(raw.items[0].status, 'filled');
  assert.equal(raw.items[0].extra, '保留');
  applyDecisionToRaw(raw, { id: 'Q-1', value: 'a', at: '2026-11-15T10:00:00Z', confirm: true });
  assert.equal(raw.items[0].status, 'decided');
});
test('matchSettlement：认得「id 选 值」，认不准就返回 null', () => {
  const q11 = { id: 'Q-11', options: [{ key: 'a', label: '扩阈值' }, { key: 'b', label: '压缩' }] };
  const q16 = { id: 'Q-16', options: [] };
  assert.equal(matchSettlement('Q-11 选 A（扩阈值）', q11), 'a');
  assert.equal(matchSettlement('Q-11 选 A', q11), 'a');
  assert.equal(matchSettlement('先做 Q-11 选 B 吧', q11), 'b');
  assert.equal(matchSettlement('Q-16 选 是', q16), 'yes');
  assert.equal(matchSettlement('Q-16 选 no', q16), 'no');
  // 以下都必须认不出 —— 宁可留在 filled 里，也不要猜
  assert.equal(matchSettlement('Q-11 选 Z', q11), null, '非法选项');
  assert.equal(matchSettlement('Q-1 选 A', q11), null, 'Q-1 不能命中 Q-11');
  assert.equal(matchSettlement('Q-16 选 A', q16), null, '是/否型只认 是/否/yes/no');
  assert.equal(matchSettlement('随便说说', q11), null);
  assert.equal(matchSettlement('', q11), null);
});
test('extractDecisionBlocks：只认 :::decisions 标记块，块外文本一律不猜', () => {
  const text = [
    '我先解释一下背景。',
    ':::decisions',
    '{"title":"甲","options":[]}',
    ':::',
    '中间还有别的段落。',
    ':::decisions',
    '{"title":"乙"}',
    ':::'
  ].join('\n');
  const blocks = extractDecisionBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(JSON.parse(blocks[0]).title, '甲');
  assert.equal(JSON.parse(blocks[1]).title, '乙');
  // 没有标记就不该抓到任何东西（哪怕文本里到处是「A 还是 B」）
  assert.deepEqual(extractDecisionBlocks('你想选 A 还是 B？'), []);
  assert.deepEqual(extractDecisionBlocks(''), []);
});
test('buildView 空文档不炸', () => {
  const view = buildView(normalizeDoc(null).doc, 5);
  assert.equal(view.pendingCount, 0);
  assert.deepEqual(view.pending, []);
  assert.deepEqual(view.decided, []);
});