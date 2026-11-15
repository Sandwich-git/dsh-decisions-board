import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 用假的模块加载器跑一遍 lib/client.js。
 * 这条测试守三件事（都是「不跑就不知道」的）：
 *   1. 产物能被 loader 解析（语法 + 顶层形状）；
 *   2. factory 只向共享基线要 react（不偷偷 require 别的相对文件）；
 *   3. apply 注册到**正确的 slot**：conversation.session.header.actions。
 */
async function loadBundle() {
  const source = await readFile(resolve(ROOT, 'lib', 'client.js'), 'utf8');
  const registry = { rows: [], requested: [] };
  const fakeWindow = {
    __ModuleLoader__: {
      load(row) {
        registry.rows.push(row);
      }
    }
  };
  // 只提供共享基线里我们用到的那一个模块；其余一律抛错，等于断言「没多要」。
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: (value) => ({ current: value }),
    useEffect: () => undefined,
    useState: (value) => [value, () => undefined]
  };
  const fakeRequire = (id) => {
    registry.requested.push(id);
    if (id === 'react') return fakeReact;
    throw new Error('bundle required a module outside the shared baseline: ' + id);
  };

  const run = new Function('window', 'document', source);
  run(fakeWindow, { baseURI: 'http://127.0.0.1:1/' });

  assert.equal(registry.rows.length, 1, 'bundle must register exactly one module row');
  const row = registry.rows[0];
  assert.equal(row.id, 'dsh-decisions-board');
  const exported = row.factory(fakeRequire);
  return { exported, registry };
}

test('client bundle 注册一条名为 dsh-decisions-board 的模块', async () => {
  const { exported } = await loadBundle();
  assert.equal(typeof exported.apply, 'function');
  assert.deepEqual(exported.inject, ['slots']);
});

test('client bundle 只向共享基线要 react（不偷偷 require 相对文件）', async () => {
  const { registry } = await loadBundle();
  assert.deepEqual([...new Set(registry.requested)], ['react']);
});

test('apply 把入口注册进 conversation.session.header.actions（R-1 的结论）', async () => {
  const { exported } = await loadBundle();
  const calls = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        calls.push({ kind: 'inject', name });
        return callback();
      },
      register(options, component) {
        calls.push({ kind: 'register', name: options.name, id: options.id, order: options.order, component });
        return () => undefined;
      }
    }
  };
  exported.apply(ctx);
  assert.deepEqual(calls.map((call) => call.kind + ':' + call.name), [
    'inject:conversation.session.header.actions',
    'register:conversation.session.header.actions'
  ]);
  assert.equal(calls[1].id, 'decisions-board');
  assert.equal(typeof calls[1].component, 'function');
});
