#!/usr/bin/env node
/**
 * 把 src/model.js + src/panel.js 内联进 lib/client.js。
 *
 * 为什么需要这一步：DSH 的浏览器插件必须是**已构建的单文件**，形如
 *   window.__ModuleLoader__.load({ id, factory: (require) => ({ apply, inject }) })
 * 且「入口与 chunk 产物不能同步 require 另一个相对 client*.js 产物」
 * （dsh-client-modules README「惰性 CJS 模型」）。
 * 所以界面代码不能靠 import 共享，只能内联 —— 但源仍然只有一份（src/）。
 *
 * 输出必须自检：内联后不得残留 import/export 语句，否则直接失败（不产出半成品）。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PACKAGE_NAME = 'dsh-decisions-board';

/** 去掉 ESM 语句，得到可直接内联进 factory 的函数体。 */
function stripEsm(source, filename) {
  const withoutImports = source
    .replace(/^import[^;]*;$/gm, '')
    .replace(/^\s*import\s.+$/gm, '');
  const withoutExports = withoutImports.replace(/^export\s+(?=(const|let|var|function|class)\b)/gm, '');
  if (/^\s*(?:import|export)\s/m.test(withoutExports)) {
    throw new Error(filename + ' still contains import/export after stripping; refusing to emit a broken bundle');
  }
  return withoutExports.trim();
}

const model = stripEsm(await readFile(resolve(ROOT, 'src', 'model.js'), 'utf8'), 'src/model.js');
const panel = stripEsm(await readFile(resolve(ROOT, 'src', 'panel.js'), 'utf8'), 'src/panel.js');

const body = `
/** 决策看板：会话区右上角的入口 + 右侧抽屉。由 tools/build-client.mjs 生成，勿手改。 */
window.__ModuleLoader__.load({
	id: '${PACKAGE_NAME}',
	factory: (require) => {
		const React = require('react');

// ── 内联 src/model.js ────────────────────────────────────────────────────────
${model}

// ── 内联 src/panel.js ───────────────────────────────────────────────────────
${panel}

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
`;

await mkdir(resolve(ROOT, 'lib'), { recursive: true });
await writeFile(resolve(ROOT, 'lib', 'client.js'), body + '\n', 'utf8');
const bytes = Buffer.byteLength(body, 'utf8');
console.log('[build-client] lib/client.js written, ' + bytes + ' bytes');
if (bytes > 8 * 1024 * 1024) throw new Error('client bundle exceeds the 8 MiB tgz budget');
