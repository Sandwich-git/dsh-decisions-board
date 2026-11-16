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

import { MISSING_COST_TEXT, badgeLabel } from './model.js';

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
export function createBoard(options = {}) {
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
