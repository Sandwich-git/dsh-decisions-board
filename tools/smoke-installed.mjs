#!/usr/bin/env node
/**
 * 对**已安装的那份产物**做冒烟：验证打包后的相对 import（../src/model.js）能解析、
 * apply 能注册两条路由、两条路由对真实文件能读能写。
 *
 * 为什么要专门测「已安装副本」：开发树里 ../src/model.js 一定在，
 * 但 files 漏了它、或 pnpm 的硬链接布局不同，都只会在安装后才炸（§1.9：夹具通过 ≠ 运行时可用）。
 *
 * 用法：node tools/smoke-installed.mjs <已安装包目录>
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('usage: node tools/smoke-installed.mjs <installed package dir>');

const entry = pathToFileURL(resolve(root, 'lib', 'index.js')).href;
const mod = await import(entry);
assert.equal(typeof mod.apply, 'function', 'installed lib/index.js must export apply');
assert.ok(Array.isArray(mod.inject) && mod.inject.includes('connection'), 'inject must include connection');

const workdir = await mkdtemp(join(tmpdir(), 'dshdb-smoke-'));
const SESSION = 'smoke-session';
await mkdir(join(workdir, '.dsh', 'decisions'), { recursive: true });
const file = join(workdir, '.dsh', 'decisions', SESSION + '.json');
await writeFile(file, JSON.stringify({
  version: 1,
  session: 'smoke',
  items: [
    { id: 'S-1', status: 'pending', title: '冒烟项', options: [{ key: 'a', label: '甲', cost: '无' }], recommended: 'a', impact: [], links: [], source: { turn: 1, anchor: 'x', quote: '好' } },
    { id: 'S-2', status: 'pending', title: '第二项', options: [], impact: [], links: [], source: {} }
  ]
}, null, 2), 'utf8');

const routes = [];
const ctx = {
  connection: { fetch: { register: (route) => routes.push(route) } },
  sandboxPolicy: { workspaceRoot: workdir },
  get(name) {
    if (name === 'sandboxPolicy') return this.sandboxPolicy;
    return undefined;
  }
};

mod.apply(ctx, {});
assert.equal(routes.length, 2, 'apply must register two routes');
assert.deepEqual(routes.map((route) => route.path).sort(), ['/api/decisions-board/decide', '/api/decisions-board/state']);

const query = '?dir=' + encodeURIComponent(workdir) + '&sessionId=' + SESSION;
const stateRoute = routes.find((route) => route.path.endsWith('/state'));
const decideRoute = routes.find((route) => route.path.endsWith('/decide'));
const stateRes = await stateRoute.fetch(new Request('http://local/api/decisions-board/state' + query));
assert.equal(stateRes.status, 200);
const state = await stateRes.json();
assert.equal(state.ok, true);
assert.equal(state.view.pendingCount, 2, 'state must count pending items');
assert.equal(state.file, file);
assert.match(state.file, /decisions[\\/]smoke-session\.json$/);

const decideRes = await decideRoute.fetch(new Request('http://local/api/decisions-board/decide' + query, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'S-1', value: 'a', by: 'user' })
}));
assert.equal(decideRes.status, 200);
const decided = await decideRes.json();
assert.equal(decided.ok, true);
assert.equal(decided.fill, 'S-1 选 A（甲）');
assert.equal(decided.view.pendingCount, 2, 'filled 仍算待拍（不静默丢板）');
assert.equal(decided.view.filledCount, 1);

const onDisk = JSON.parse(await readFile(file, 'utf8'));
const written = onDisk.items.find((item) => item.id === 'S-1');
assert.equal(written.status, 'filled', '默认只到 filled');
assert.equal(written.decided.value, 'a');

const confirmRes = await decideRoute.fetch(new Request('http://local/api/decisions-board/decide' + query, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'S-1', value: 'a', by: 'user', confirm: true })
}));
assert.equal(confirmRes.status, 200);
const confirmed = await confirmRes.json();
assert.equal(confirmed.view.pendingCount, 1, 'confirm 后才离开待拍');
const finalDoc = JSON.parse(await readFile(file, 'utf8'));
assert.equal(finalDoc.items.find((item) => item.id === 'S-1').status, 'decided');

const badRes = await decideRoute.fetch(new Request('http://local/api/decisions-board/decide' + query, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'nope', value: 'a' })
}));
assert.equal(badRes.status, 400, 'unknown id must be a 400, not a silent write');

console.log('[smoke-installed] OK · installed at ' + root);
console.log('[smoke-installed] routes: ' + routes.map((route) => route.path).join(' , '));
console.log('[smoke-installed] decide -> filled (pending 2) -> confirm -> decided (pending 1)');
