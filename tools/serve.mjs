#!/usr/bin/env node
/**
 * 零依赖本机预览页：不依赖任何 DSH 插件 API，只验证「文件变动 → 界面更新 → 选择回填」。
 *
 * 界面部分是同一份 panel 代码，所以这里看到的就是插件里的样子。
 *
 * 用法：
 *   node tools/serve.mjs --file <工作区>/.dsh/decisions/<sessionId>.json
 * 端口默认随机（0），打印实际 URL。⚠️ 不要写死端口 —— 并行会话会互相污染。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildView, normalizeDoc, withDecision, withDismiss } from '../src/model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    if (eq > 0) args.set(token.slice(2, eq), token.slice(eq + 1));
    else args.set(token.slice(2), process.argv[index + 1] ?? '');
  }
}

const file = resolve(args.get('file') ?? join(process.cwd(), '.dsh', 'decisions.json'));
const port = Number(args.get('port') ?? 0);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

async function readDoc() {
  try {
    const raw = await readFile(file, 'utf8');
    const { doc, problems } = normalizeDoc(JSON.parse(raw));
    return { doc, problems, missing: false };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { doc: normalizeDoc({ version: 1, session: '', items: [] }).doc, problems: [], missing: true };
    }
    return { doc: normalizeDoc({ version: 1, session: '', items: [] }).doc, problems: ['读取失败：' + String(error?.message ?? error)], missing: true };
  }
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  response.end(payload);
}

async function serveStatic(response, pathname) {
  const map = {
    '/': join(ROOT, 'public', 'index.html'),
    '/app.js': join(ROOT, 'public', 'app.js'),
    '/src/model.js': join(ROOT, 'src', 'model.js'),
    '/src/panel.js': join(ROOT, 'src', 'panel.js')
  };
  const target = map[pathname];
  if (target === undefined) return false;
  try {
    const bytes = await readFile(target);
    response.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(bytes);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(String(error?.message ?? error));
  }
  return true;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && (await serveStatic(response, url.pathname))) return;

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const read = await readDoc();
    json(response, 200, { ok: true, file, missing: read.missing, problems: read.problems, view: buildView(read.doc, 5) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/decide') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      json(response, 400, { ok: false, error: 'body must be JSON' });
      return;
    }
    const read = await readDoc();
    try {
      // 预览页也要能验「手动关闭」这条路径，否则界面在预览里和插件里长得不一样。
      const applied = body.dismiss === true ? withDismiss(read.doc, body) : withDecision(read.doc, body);
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(applied.doc, null, 2) + '\n', 'utf8');
      json(response, 200, { ok: true, fill: applied.fill, sentence: applied.sentence, view: buildView(applied.doc, 5) });
    } catch (error) {
      json(response, 400, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  json(response, 404, { ok: false, error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log('[decisions-board] file: ' + file);
  console.log('[decisions-board] http://127.0.0.1:' + actual + '/');
});
