import { createBoard } from '/src/panel.js';

const POLL_MS = 1000;
const triggerSlot = document.getElementById('trigger-slot');
const composer = document.getElementById('composer');
const verdict = document.getElementById('verdict');

const board = createBoard({
  fillHint: '已填入下面的输入框 —— 这里只是验证页，不会发送',
  onLink: (link) => {
    verdict.textContent = '链接（验证页不跳转）：' + link;
  },
  onConfirm: async (id, value) => {
    const response = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, value, by: 'YG', confirm: true })
    });
    const body = await response.json();
    if (!body.ok) throw new Error(body.error ?? 'confirm failed');
    board.setView(body.view);
    verdict.textContent = body.sentence ?? ('已定：' + body.fill);
    return body.sentence ?? ('已定：' + body.fill);
  },
  onDecide: async (id, value) => {
    const response = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, value, by: 'YG' })
    });
    const body = await response.json();
    if (!body.ok) throw new Error(body.error ?? 'decide failed');
    board.setView(body.view);
    composer.value = body.fill;
    composer.focus();
    verdict.textContent = '已回填：' + body.fill + '（未发送）';
  }
});

board.attachTrigger(triggerSlot);
board.open();

async function poll() {
  try {
    const response = await fetch('/api/state');
    const body = await response.json();
    if (!body.ok) throw new Error(body.error ?? 'state failed');
    board.setView(body.view);
    document.title = '待拍 ' + body.view.pendingCount + ' · 决策看板';
  } catch (error) {
    verdict.textContent = '读取失败：' + String(error?.message ?? error);
  }
}

await poll();
setInterval(poll, POLL_MS);
