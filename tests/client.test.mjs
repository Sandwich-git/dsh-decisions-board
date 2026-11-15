import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildView, normalizeDoc, withDecision } from '../src/model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 客户端半的行为测试：最小 DOM 替身 + 假 React，把 lib/client.js 真的跑一遍。
 *
 * 守的是三件「跑起来才知道」的事：
 *   1. 两个请求都带 sessionId（0.1.1 的 decide 漏了 ⇒ 宿主 400）；
 *   2. 回填走 setDraft 而不是 insertText（dsh-voice-plus 会把 insertText 猴补丁成 LLM 校对）；
 *   3. 没有选项的条目也给出「是 / 否」两个可点的按钮（0.1.3 之前是空着不给按钮）。
 */

function makeNode(tag) {
  const node = {
    tagName: tag, children: [], dataset: {}, style: {}, attrs: {}, _listeners: {},
    className: '', hidden: false, disabled: false, type: '', parentNode: null,
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    remove() {
      const parent = node.parentNode;
      if (parent === null) return;
      const index = parent.children.indexOf(node);
      if (index >= 0) parent.children.splice(index, 1);
      node.parentNode = null;
    },
    addEventListener(type, handler) { (node._listeners[type] ||= []).push(handler); },
    setAttribute(name, value) { node.attrs[name] = value; },
    querySelector() { return null; },
    focus() {},
    dispatch(type, event = {}) {
      for (const handler of node._listeners[type] ?? []) handler(event);
    }
  };
  // 贴近真 DOM：读 textContent 要拼接子文本；写 textContent 清空子节点（面板就是这样清列表的）。
  Object.defineProperty(node, 'textContent', {
    get() {
      if (node.children.length === 0) return node._text ?? '';
      return node.children.map((child) => (child.nodeType === 3 ? child.text : child.textContent)).join('');
    },
    set(value) { node._text = value; node.children.length = 0; }
  });
  return node;
}

function makeDocument() {
  const head = makeNode('head');
  const body = makeNode('body');
  return {
    baseURI: 'http://127.0.0.1:1/', head, body,
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, text }),
    querySelector: () => null
  };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** 找某条决策的卡片节点（卡片带 data-item-id / data-status）。 */
function findCard(document, itemId) {
  let found = null;
  walk(document.body, (node) => {
    if (found === null && node.className === 'dshdb-card' && node.dataset.itemId === itemId) found = node;
  });
  return found;
}

/** 在某个卡片里找某个选项的按钮。 */
function findPick(document, itemId, optionKey) {
  let found = null;
  walk(document.body, (node) => {
    if (found !== null) return;
    if (node.className !== 'dshdb-card' || node.dataset.itemId !== itemId) return;
    walk(node, (inner) => {
      if (found === null && inner.className === 'dshdb-pick' && inner.attrs['data-option-key'] === optionKey) found = inner;
    });
  });
  return found;
}

const BASE_DOC = normalizeDoc({
  version: 1,
  session: 's',
  items: [
    {
      id: 'Q-11', kind: 'choice', title: '这一版先发还是再等一个需求', question: '两个改动做完了，第三个还在讨论。',
      options: [{ key: 'a', label: '先发', cost: '第三个需求要等下一版' }], recommended: 'a',
      impact: ['使用者等不等得到'], links: [], source: { turn: 12, anchor: 'msg-q11', quote: '先发一版看看' }
    },
    {
      id: 'Q-16', kind: 'choice', title: '要不要把 .dsh/ 写进 .gitignore',
      question: '数据文件会出现在 git status 里。',
      options: [], impact: ['仓库卫生'], links: [], source: { turn: 48, anchor: 'msg-q16', quote: '别混进提交范围' }
    }
  ]
}).doc;

const PENDING_VIEW = buildView(BASE_DOC, 5);

async function mountClient(sessionId, draft = '') {
  const source = await readFile(resolve(ROOT, 'lib', 'client.js'), 'utf8');
  const document = makeDocument();
  const calls = [];
  const draftWrites = [];
  const insertWrites = [];
  let cleanup = null;

  // like the real host: decide 落 filled，confirm 才落 decided
  let current = BASE_DOC;
  const fetchStub = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body });
    return {
      async json() {
        if (target.includes('/state')) return { ok: true, view: buildView(current, 5) };
        const payload = JSON.parse(init.body);
        const applied = withDecision(current, {
          id: payload.id,
          value: payload.value,
          by: payload.by,
          confirm: payload.confirm === true
        });
        current = applied.doc;
        return {
          ok: true,
          view: buildView(current, 5),
          fill: applied.fill,
          ...payload.confirm === true ? { sentence: '已定：' + applied.fill } : {}
        };
      }
    };
  };
  Object.defineProperty(globalThis, 'fetch', { value: fetchStub, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => undefined } }, configurable: true });

  const hostNodes = [];
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: () => { const node = makeNode('span'); hostNodes.push(node); return { current: node }; },
    useEffect: (effect) => { cleanup = effect(); }
  };
  const fakeRequire = (id) => {
    if (id === 'react') return fakeReact;
    throw new Error('unexpected module: ' + id);
  };

  const registry = [];
  const fakeWindow = { __ModuleLoader__: { load: (row) => registry.push(row) } };
  new Function('window', 'document', source)(fakeWindow, document);
  const exported = registry[0].factory(fakeRequire);

  let component = null;
  exported.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (options, registered) => { component = registered; return () => undefined; }
    }
  });
  assert.equal(typeof component, 'function', 'apply must register a component');

  const inputActions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: (value) => { insertWrites.push(value); return true; },
    setDraft: (value) => { draftWrites.push(value); }
  };

  component({ sessionId, inputActions, useInput: (selector) => selector({ draft }) });
  await new Promise((resolveTick) => setImmediate(resolveTick));

  return {
    calls, inputActions, draftWrites, insertWrites, document,
    host: hostNodes[0],
    open() {
      const trigger = hostNodes[0].children.find((node) => node.className === 'dshdb-trigger');
      assert.ok(trigger !== undefined, 'trigger must be mounted into the slot host');
      trigger.dispatch('click');
    },
    stop: () => { if (typeof cleanup === 'function') cleanup(); }
  };
}

async function clickPick(client, itemId, optionKey) {
  client.open();
  const pick = findPick(client.document, itemId, optionKey);
  assert.ok(pick !== undefined, 'missing pick ' + itemId + '/' + optionKey);
  pick.dispatch('click');
  await new Promise((resolveTick) => setImmediate(resolveTick));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  return pick;
}

test('轮询 state 时带上 sessionId（否则宿主查不到工作目录）', async () => {
  const client = await mountClient('S1');
  try {
    assert.equal(client.calls[0].url, 'http://127.0.0.1:1/api/decisions-board/state?sessionId=S1');
  } finally { client.stop(); }
});

test('点选项后 POST decide 带 sessionId，且回填走 setDraft', async () => {
  const client = await mountClient('S1');
  try {
    await clickPick(client, 'Q-11', 'a');
    const decide = client.calls.find((call) => call.url.includes('/decide'));
    assert.ok(decide !== undefined, 'clicking an option must POST to decide');
    assert.equal(decide.method, 'POST');
    assert.equal(decide.url, 'http://127.0.0.1:1/api/decisions-board/decide?sessionId=S1');
    assert.deepEqual(JSON.parse(decide.body), { id: 'Q-11', value: 'a', by: 'YG' });
    assert.deepEqual(client.draftWrites, ['Q-11 选 A（先发）'], '空草稿时就是那一句');
    assert.deepEqual(client.insertWrites, [], '不许走 insertText（会被别的插件劫持）');
  } finally { client.stop(); }
});

test('没有选项的条目也有「是 / 否」两个按钮，点「是」按 yes 落库', async () => {
  const client = await mountClient('S1');
  try {
    assert.equal(findPick(client.document, 'Q-16', 'yes'), null, '抽屉还没打开时按钮不在 body 里');
    client.open();
    assert.ok(findPick(client.document, 'Q-16', 'yes') !== null, '「是」按钮必须存在');
    assert.ok(findPick(client.document, 'Q-16', 'no') !== null, '「否」按钮必须存在');
    findPick(client.document, 'Q-16', 'yes').dispatch('click');
    await new Promise((resolveTick) => setImmediate(resolveTick));
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const decide = client.calls.find((call) => call.url.includes('/decide'));
    assert.deepEqual(JSON.parse(decide.body), { id: 'Q-16', value: 'yes', by: 'YG' });
  } finally { client.stop(); }
});

test('草稿里已有文字时并成新行，不覆盖人已经打的字', async () => {
  const client = await mountClient('S1', '我已经打了一半');
  try {
    await clickPick(client, 'Q-11', 'a');
    assert.deepEqual(client.draftWrites, ['我已经打了一半\nQ-11 选 A（先发）']);
    assert.deepEqual(client.insertWrites, []);
  } finally { client.stop(); }
});

test('即使 insertText 被别的插件猴补丁，回填也不会走进它（voice-plus 事故的回归）', async () => {
  const client = await mountClient('S1');
  const swallowed = [];
  const original = client.inputActions.insertText;
  try {
    client.inputActions.insertText = (value) => { swallowed.push(value); return true; };
    await clickPick(client, 'Q-11', 'a');
    assert.deepEqual(swallowed, [], '被劫持的 insertText 一次都不该被调用');
    assert.deepEqual(client.draftWrites, ['Q-11 选 A（先发）'], '文本仍然原样落进草稿');
  } finally {
    client.inputActions.insertText = original;
    client.stop();
  }
});test('点完选项后卡片仍留在清单里（已回填·待发送），不静默消失', async () => {
  const client = await mountClient('S1');
  try {
    await clickPick(client, 'Q-11', 'a');
    // 抽屉是开着的，卡片应仍在，并带「我已发送」按钮
    const card = findCard(client.document, 'Q-11');
    assert.ok(card !== null, '已回填的条目必须继续可见（这正是之前静默丢板的地方）');
    assert.equal(card.dataset.status, 'filled', '状态必须是 filled（已回填待发送），不能是 decided');
    let confirmButton = null;
    walk(client.document.body, (node) => {
      if (node.attrs && node.attrs['data-action'] === 'confirm') confirmButton = node;
    });
    assert.ok(confirmButton !== null, '必须有「我已发送，标记为已定」的出口');
  } finally { client.stop(); }
});

test('点「我已发送」才发 confirm:true，条目这才离开清单', async () => {
  const client = await mountClient('S1');
  try {
    await clickPick(client, 'Q-11', 'a');
    let confirmButton = null;
    walk(client.document.body, (node) => {
      if (node.attrs && node.attrs['data-action'] === 'confirm') confirmButton = node;
    });
    confirmButton.dispatch('click');
    await new Promise((resolveTick) => setImmediate(resolveTick));
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const posts = client.calls.filter((call) => call.url.includes('/decide'));
    assert.equal(posts.length, 2, '两次 POST：先 decide，再 confirm');
    assert.deepEqual(JSON.parse(posts[0].body), { id: 'Q-11', value: 'a', by: 'YG' });
    assert.deepEqual(JSON.parse(posts[1].body), { id: 'Q-11', value: 'a', by: 'YG', confirm: true });
    assert.equal(findCard(client.document, 'Q-11').dataset.status, 'decided', '确认后才移到已定');
    let toast = null;
    walk(client.document.body, (node) => {
      if (node.className === 'dshdb-toast') toast = node;
    });
    assert.ok(toast !== null, '确认后要给一句复述');
    assert.match(toast.textContent, /已定：Q-11 选 A（先发）/, '复述句由宿主提供、原样显示');
  } finally { client.stop(); }
});