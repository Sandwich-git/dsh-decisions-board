import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 宿主半的行为测试：真的调两条路由，真的读写文件。
 * 这里抓过的缺陷（保留为回归）：bad() 曾经吞掉 status 参数 ⇒ 未知 id 也回 200，
 * 前端会以为「决定已写入」，而文件其实没变。
 */
async function mount(config) {
  const mod = await import(new URL('../lib/index.js', import.meta.url).href);
  const workdir = await mkdtemp(join(tmpdir(), 'dshdb-host-'));
  await mkdir(join(workdir, '.dsh'), { recursive: true });
  const SESSION = 'sess-1';
  const file = join(workdir, '.dsh', 'decisions', SESSION + '.json');
  await mkdir(join(workdir, '.dsh', 'decisions'), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: 1,
    session: 'test',
    items: [
      { id: 'S-1', status: 'pending', title: '甲项', options: [{ key: 'a', label: '甲', cost: '无' }, { key: 'b', label: '乙' }], recommended: 'a', impact: [], links: [], source: { turn: 1, anchor: 'x', quote: '好' }, humanNote: '人手加的字段，写回时必须保留', tags: ['x'] },
      { id: 'S-2', status: 'pending', title: '乙项', options: [], impact: [], links: [], source: {} }
    ]
  }, null, 2), 'utf8');
  const routes = [];
  const tools = [];
  const listeners = [];
  const sections = [];
  const ctx = {
    connection: { fetch: { register: (route) => routes.push(route) } },
    tools: { register: (definition) => tools.push(definition) },
    systemPrompt: { section: (spec) => { sections.push(spec); return () => undefined; } },
    effect(callback) { return callback(); },
    on(name, listener) {
      listeners.push({ name, listener });
      return () => undefined;
    },
    sandboxPolicy: { workspaceRoot: workdir },
    config: {},
    get(name) {
      if (name === 'sandboxPolicy') return ctx.sandboxPolicy;
      if (name === 'tools') return ctx.tools;
      if (name === 'systemPrompt') return ctx.systemPrompt;
      return undefined;
    }
  };
  mod.apply(ctx, config);
  const query = '?dir=' + encodeURIComponent(workdir) + '&sessionId=' + SESSION;
  return {
    file,
    workdir,
    session: SESSION,
    routes,
    tools,
    listeners,
    sections,
    state: () => routes.find((route) => route.path.endsWith('/state')).fetch(new Request('http://local/api/decisions-board/state' + query)),
    decide: (body) => routes.find((route) => route.path.endsWith('/decide')).fetch(new Request('http://local/api/decisions-board/decide' + query, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }))
  };
}

test('apply 注册 state 与 decide 两条路由，且都在自己的前缀下', async () => {
  const { routes } = await mount();
  assert.deepEqual(routes.map((route) => route.path).sort(), ['/api/decisions-board/decide', '/api/decisions-board/state']);
  assert.deepEqual(routes.find((route) => route.path.endsWith('/state')).methods, ['GET']);
  assert.deepEqual(routes.find((route) => route.path.endsWith('/decide')).methods, ['POST']);
});

test('state 读真实文件：pending 计数与 file 路径都对', async () => {
  const host = await mount();
  const response = await host.state();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.view.pendingCount, 2);
  assert.equal(body.file, host.file);
});

test('decide 写回 filled（不是 decided）并返回回填句；别的字段不动', async () => {
  const host = await mount();
  const response = await host.decide({ id: 'S-1', value: 'a', by: 'someone' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fill, 'S-1 选 A（甲）');
  assert.equal(body.view.pendingCount, 2, 'filled 仍算待拍 —— 静默丢板的反面');
  assert.equal(body.view.filledCount, 1);
  const onDisk = JSON.parse(await readFile(host.file, 'utf8'));
  const written = onDisk.items.find((item) => item.id === 'S-1');
  assert.equal(written.status, 'filled');
  assert.equal(written.decided.value, 'a');
  assert.equal(written.decided.by, 'someone');
  assert.equal(written.title, '甲项', 'decide must not touch other fields');
  assert.equal(onDisk.items.find((item) => item.id === 'S-2').status, 'pending');
});

test('confirm=true 才把 filled 提升为 decided（人点「我已发送」的路径）', async () => {
  const host = await mount();
  await host.decide({ id: 'S-1', value: 'a', by: 'someone' });
  const response = await host.decide({ id: 'S-1', value: 'a', by: 'someone', confirm: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.view.pendingCount, 1, '确认后才离开待拍');
  assert.equal(body.view.filledCount, 0);
  const onDisk = JSON.parse(await readFile(host.file, 'utf8'));
  assert.equal(onDisk.items.find((item) => item.id === 'S-1').status, 'decided');
});

test('写回时保留 normalizeDoc 不认识的字段（文件是给人手改的，不能被覆盖掉）', async () => {
  const host = await mount();
  const response = await host.decide({ id: 'S-1', value: 'a', by: 'someone' });
  assert.equal(response.status, 200);
  const onDisk = JSON.parse(await readFile(host.file, 'utf8'));
  const written = onDisk.items.find((item) => item.id === 'S-1');
  assert.equal(written.humanNote, '人手加的字段，写回时必须保留');
  assert.deepEqual(written.tags, ['x']);
  assert.equal(written.question, undefined, '未声明的字段不该凭空出现');
});

test('未知 id 回 400 且不写文件（回归：曾经回 200）', async () => {
  const host = await mount();
  const before = await readFile(host.file, 'utf8');
  const response = await host.decide({ id: 'nope', value: 'a' });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /unknown decision id/);
  assert.equal(await readFile(host.file, 'utf8'), before, 'a rejected decide must not rewrite the file');
});

test('非法选项值回 400；缺 value 回 400', async () => {
  const host = await mount();
  assert.equal((await host.decide({ id: 'S-1', value: 'zzz' })).status, 400);
  assert.equal((await host.decide({ id: 'S-1', value: '' })).status, 400);
});

test('apply 注册 decisions_board 工具（agent 侧收口入口）', async () => {
  const host = await mount();
  assert.equal(host.tools.length, 1);
  const tool = host.tools[0];
  assert.equal(tool.name, 'decisions_board');
  for (const key of ['action', 'id', 'value', 'note', 'dir']) {
    assert.ok(tool.parameters[key] !== undefined, 'missing parameter ' + key);
  }
});

test('工具 action=list 只列还等着人动手的条目，并给出复述句', async () => {
  const host = await mount();
  const tool = host.tools[0];
  await host.decide({ id: 'S-1', value: 'a', by: 'someone' });
  const listed = await tool.execute({ action: 'list', dir: host.workdir, sessionId: host.session });
  assert.equal(listed.pendingCount, 2, 'filled 与 pending 都在');
  assert.equal(listed.filledCount, 1);
  const filled = listed.items.find((item) => item.id === 'S-1');
  assert.equal(filled.status, 'filled');
  assert.equal(filled.sentence, '已定：S-1 选 A（甲）', '复述句要能直接说出口');
});

test('工具 action=settle 把 filled 收口为 decided，并返回复述句', async () => {
  const host = await mount();
  const tool = host.tools[0];
  await host.decide({ id: 'S-1', value: 'a', by: 'someone' });
  const settled = await tool.execute({ action: 'settle', id: 'S-1', dir: host.workdir, sessionId: host.session });
  assert.equal(settled.settled, 'S-1');
  assert.equal(settled.value, 'a');
  assert.equal(settled.sentence, '已定：S-1 选 A（甲）');
  assert.equal(settled.pendingCount, 1, '收口后离开待拍');
  const onDisk = JSON.parse(await readFile(host.file, 'utf8'));
  const written = onDisk.items.find((item) => item.id === 'S-1');
  assert.equal(written.status, 'decided');
  assert.equal(written.decided.by, 'agent', 'agent 收口要能追溯到来源');
});

test('工具 action=settle 对未知 id / 没回填值的条目报错（不写坏文件）', async () => {
  const host = await mount();
  const tool = host.tools[0];
  await assert.rejects(() => tool.execute({ action: 'settle', id: 'nope', dir: host.workdir, sessionId: host.session }), /unknown decision id/);
  await assert.rejects(() => tool.execute({ action: 'settle', id: 'S-2', dir: host.workdir, sessionId: host.session }), /需要 value/);
});
test('默认订阅两个 session/event：自动收口（user/message）+ 自动新增（assistant/message）', async () => {
  const host = await mount();
  assert.equal(host.listeners.length, 2);
  assert.deepEqual(host.listeners.map((entry) => entry.name), ['session/event', 'session/event']);
});

test('人在会话里发出答案 ⇒ 自动收口为 decided（by: user-message），不需要任何项目约定', async () => {
  const host = await mount();
  const emit = host.listeners[0].listener;
  await host.decide({ id: 'S-1', value: 'a', by: 'someone' });
  const session = { id: host.session, header: { id: host.session, cwd: host.workdir } };
  emit(session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'S-1 选 A（甲）' }] }
  });
  await new Promise((tick) => setTimeout(tick, 60));
  const onDisk = JSON.parse(await readFile(host.file, 'utf8'));
  const written = onDisk.items.find((item) => item.id === 'S-1');
  assert.equal(written.status, 'decided');
  assert.equal(written.decided.by, 'user-message');
});

test('自动收口只认 source.kind=user，且只认「id 选 值」形态（认不准就不动）', async () => {
  const host = await mount();
  const emit = host.listeners[0].listener;
  const session = { id: host.session, header: { id: host.session, cwd: host.workdir } };
  await host.decide({ id: 'S-1', value: 'a', by: 'someone' });
  // 1) agent 自己的消息
  emit(session, { type: 'user/message', data: { source: { kind: 'user-rpc' }, content: [{ type: 'text', text: 'S-1 选 A' }] } });
  // 2) 随口提到，但不是答案形态
  emit(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'S-1 那个事你怎么看' }] } });
  // 3) 答案不合法
  emit(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'S-1 选 Z' }] } });
  await new Promise((tick) => setTimeout(tick, 80));
  const onDisk = JSON.parse(await readFile(host.file, 'utf8'));
  assert.equal(onDisk.items.find((item) => item.id === 'S-1').status, 'filled', '一条都不该被收口');
});

test('autoSettle:false 时只剩捕获那一个订阅；两个都关就一个都不订', async () => {
  const onlyCapture = await mount({ autoSettle: false });
  assert.equal(onlyCapture.listeners.length, 1, '关掉收口不影响自动新增');
  const none = await mount({ autoSettle: false, autoCapture: false });
  assert.equal(none.listeners.length, 0, '两个都关就完全不订阅');
  assert.equal(none.sections.length, 0, '也不注入提示段');
});
test('同一工作区的两个会话各自一份文件（会话级隔离，不能互相看见）', async () => {
  const host = await mount();
  const other = host.session + '-other';
  const stateRoute = host.routes.find((route) => route.path.endsWith('/state'));
  const decideRoute = host.routes.find((route) => route.path.endsWith('/decide'));
  const q = (sid) => '?dir=' + encodeURIComponent(host.workdir) + '&sessionId=' + sid;

  // A 会话里选了一个
  const decided = await decideRoute.fetch(new Request('http://local/api/decisions-board/decide' + q(host.session), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'S-1', value: 'a', by: 'someone' })
  }));
  assert.equal(decided.status, 200);

  // B 会话必须是另一个文件、且看不到 A 的改动
  const stateB = await (await stateRoute.fetch(new Request('http://local/api/decisions-board/state' + q(other)))).json();
  assert.notEqual(stateB.file, host.file, '两个会话不能共用一个文件');
  assert.match(stateB.file, /decisions[\\/]sess-1-other\.json$/);
  assert.equal(stateB.missing, true, 'B 会话还没有自己的文件');
  assert.equal(stateB.view.pendingCount, 0);

  // A 的改动落在 A 的文件里
  const onDisk = JSON.parse(await readFile(host.file, 'utf8'));
  assert.equal(onDisk.items.find((item) => item.id === 'S-1').status, 'filled');
});

test('缺 sessionId 时回 400（不允许悄悄退化成工作区级共享）', async () => {
  const host = await mount();
  const stateRoute = host.routes.find((route) => route.path.endsWith('/state'));
  const res = await stateRoute.fetch(new Request('http://local/api/decisions-board/state?dir=' + encodeURIComponent(host.workdir)));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /sessionId is required/);
});

test('会话 id 里的路径分隔符被收窄 —— 文件必须落在 <dir>/.dsh/decisions/ 内', async () => {
  const host = await mount();
  const stateRoute = host.routes.find((route) => route.path.endsWith('/state'));
  const res = await stateRoute.fetch(new Request('http://local/api/decisions-board/state?dir=' + encodeURIComponent(host.workdir) + '&sessionId=' + encodeURIComponent('../evil')));
  assert.equal(res.status, 200);
  const body = await res.json();
  const dir = resolve(host.workdir, '.dsh', 'decisions');
  assert.equal(resolve(body.file).startsWith(dir + sep), true, '不能跳出会话目录：' + body.file);
  assert.equal(body.file.includes('/'), false, '文件名里不该再有路径分隔符');
});
test('action=add：文件不存在时会新建目录与文件，自动编号 Q-1', async () => {
  const fs = await import('node:fs/promises');
  const { mkdtemp, rm } = fs;
  const emptyDir = await mkdtemp(join(tmpdir(), 'dshdb-empty-'));
  try {
    const host = await mount();
    const tool = host.tools[0];
    // 用一个全新目录，确保「工作区里没有 decisions 文件」
    const res = await tool.execute({ action: 'add', dir: emptyDir, sessionId: 'fresh-session', title: '要不要开新分支', question: '主分支上有未完成的改动。', options: [], quote: '先别动主分支' });
    assert.equal(res.added, 'Q-1', '没有历史编号就从 Q-1 开始');
    assert.match(res.file, /decisions[\\/]fresh-session\.json$/);
    const onDisk = JSON.parse(await fs.readFile(res.file, 'utf8'));
    assert.equal(onDisk.items.length, 1);
    assert.equal(onDisk.items[0].status, 'pending');
    assert.equal(onDisk.items[0].title, '要不要开新分支');
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test('action=add：接着已有编号往后排，且拒绝重复 id 与非法选项', async () => {
  const host = await mount();
  const tool = host.tools[0];
  const added = await tool.execute({ action: 'add', dir: host.workdir, sessionId: host.session, title: '第三件要拍的事', options: [{ key: 'a', label: '甲', cost: '两行' }], recommended: 'a' });
  assert.equal(added.added, 'Q-1', '夹具里只有 S-1/S-2，自动编号从 Q-1 起');
  const again = await tool.execute({ action: 'add', dir: host.workdir, sessionId: host.session, title: '第四件', options: [] });
  assert.equal(again.added, 'Q-2');
  await assert.rejects(() => tool.execute({ action: 'add', dir: host.workdir, sessionId: host.session, title: '撞号', id: 'Q-1' }), /id 已存在/);
  await assert.rejects(() => tool.execute({ action: 'add', dir: host.workdir, sessionId: host.session, title: '写歪了', options: [{ key: 'a' }] }), /key 与 label/);
  await assert.rejects(() => tool.execute({ action: 'add', dir: host.workdir, sessionId: host.session, title: '建议对不上', options: [{ key: 'a', label: '甲' }], recommended: 'z' }), /recommended/);
  await assert.rejects(() => tool.execute({ action: 'add', dir: host.workdir, sessionId: host.session }), /需要 title/);
});

test('action=add 写完后 action=list 立刻能看到（同一条链路）', async () => {
  const host = await mount();
  const tool = host.tools[0];
  await tool.execute({ action: 'add', dir: host.workdir, sessionId: host.session, title: '新的一条', options: [{ key: 'a', label: '甲', cost: '无' }], recommended: 'a' });
  const listed = await tool.execute({ action: 'list', dir: host.workdir, sessionId: host.session });
  assert.equal(listed.pendingCount, 3, '夹具 2 条 + 新增 1 条');
  assert.ok(listed.items.some((item) => item.id === 'Q-1' && item.status === 'pending'));
});
test('工具描述与实际行为不许漂移（历史教训：路径还写工作区级、action 少了 add）', async () => {
  const host = await mount();
  const tool = host.tools[0];
  const text = tool.description;
  // 1) 三个 action 都要提到（少一个，模型就不知道有这个能力）
  for (const action of ['action=add', 'action=list', 'action=settle']) {
    assert.ok(text.includes(action), 'description 缺少 ' + action);
  }
  // 2) 路径必须写会话级（0.1.8 的破坏性变更）
  assert.ok(text.includes('decisions/<sessionId>.json'), 'description 的路径必须写会话级');
  assert.ok(!text.includes('.dsh/decisions.json）'), 'description 不许再写工作区级单文件');
  // 3) 必须交代「什么时候该写」—— 这是即插即用的关键一句
  assert.ok(text.includes('要人拍板时'), 'description 必须说明何时调用');
  // 4) parameters 里声明的 action 值也要齐
  assert.match(tool.parameters.action.description, /add/);
});
test('注入系统提示段：告诉模型 :::decisions 格式（装完即用的关键）', async () => {
  const host = await mount();
  assert.equal(host.sections.length, 1);
  const spec = host.sections[0];
  assert.ok(spec.text.includes(':::decisions'), '提示里必须有标记语法');
  assert.ok(spec.text.includes('当你要人拍板时'), '提示里必须说明何时使用');
  assert.equal(spec.interpolate, false, 'JSON 花括号不能交给变量解析');
});

test('模型在消息里写 :::decisions 块 ⇒ 自动新增待拍项（不用调工具）', async () => {
  const host = await mount();
  const emit = host.listeners.filter((entry) => entry.name === 'session/event').map((entry) => entry.listener);
  const session = { id: host.session, header: { id: host.session, cwd: host.workdir } };
  const payload = {
    kind: 'choice',
    title: '要不要把这个插件开源',
    question: '现在只有本机在用。',
    options: [{ key: 'a', label: '开源', cost: '要脱敏' }, { key: 'b', label: '私有', cost: '别人用不上' }],
    recommended: 'a',
    quote: '装完即用才是真的好用'
  };
  const body = '先说结论。\n:::decisions\n' + JSON.stringify(payload) + '\n:::\n以上。';
  for (const listener of emit) listener(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: body }] } } });
  await new Promise((tick) => setTimeout(tick, 120));
  const onDisk = JSON.parse(await readFile(host.file, 'utf8'));
  const added = onDisk.items.find((item) => item.title === '要不要把这个插件开源');
  assert.ok(added !== undefined, '必须自动落盘');
  assert.equal(added.status, 'pending');
  assert.equal(added.options.length, 2);
  assert.equal(added.recommended, 'a');
});

test('同一条消息重复投递只加一次；块外文本不抓；坏 JSON 不写', async () => {
  const host = await mount();
  const emit = host.listeners.filter((entry) => entry.name === 'session/event').map((entry) => entry.listener);
  const session = { id: host.session, header: { id: host.session, cwd: host.workdir } };
  const good = ':::decisions\n' + JSON.stringify({ title: '只该出现一次', question: 'q', options: [] }) + '\n:::';
  const emitAll = (text) => {
    for (const listener of emit) listener(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
  };
  emitAll(good);
  await new Promise((tick) => setTimeout(tick, 80));
  emitAll(good);
  emitAll('你想选 A 还是 B？');
  emitAll(':::decisions\n{ 这不是 JSON }\n:::'.replace('{ 这不是 JSON }', '{oops'));
  await new Promise((tick) => setTimeout(tick, 120));
  const onDisk = JSON.parse(await readFile(host.file, 'utf8'));
  const matches = onDisk.items.filter((item) => item.title === '只该出现一次');
  assert.equal(matches.length, 1, '重复投递不能重复添加');
  assert.equal(onDisk.items.length, 3, '夹具 2 条 + 自动 1 条');
});

test('autoCapture:false 时不注入提示段、也不订阅 assistant/message', async () => {
  const host = await mount({ autoCapture: false });
  assert.equal(host.sections.length, 0);
  const eventListeners = host.listeners.filter((entry) => entry.name === 'session/event');
  assert.equal(eventListeners.length, 1, '只剩自动收口那一个订阅');
});
test('dir 不是绝对路径时回 400（不静默改用别的目录）', async () => {
  const host = await mount();
  const response = await host.routes.find((route) => route.path.endsWith('/state'))
    .fetch(new Request('http://local/api/decisions-board/state?dir=relative/path'));
  assert.equal(response.status, 400);
});