/* 底部弹层 / 轻提示 / 确认框 */
import { h } from './util.js';

let hideTimer = null;

export function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => node.classList.remove('show'), 1900);
}

/**
 * 打开底部弹层。支持「弹层里再开弹层」（例如在添加纪念日时弹出日期选择器）：
 * 每一层挂在 #sheet-root 下各自独立，关掉上层后下层原样还在。
 * @param {{title?:string, subtitle?:string, content:Node|Node[], actions?:Node[], onClose?:Function}} opts
 * @returns {{close:Function, root:HTMLElement}}
 */
export function openSheet({ title, subtitle, content, actions, onClose }) {
  const host = document.getElementById('sheet-root');

  const backdrop = h('div.backdrop');
  const sheet = h('div.sheet');
  const handle = h('div.grab');
  const layer = h('div.sheet-layer');

  sheet.append(handle);
  if (title) sheet.append(h('h2', title));
  if (subtitle) sheet.append(h('div.sub', subtitle));
  const body = h('div.sheet-body', content);
  sheet.append(body);
  if (actions?.length) sheet.append(h('div.sheet-actions', actions));
  layer.append(backdrop, sheet);
  host.append(layer);
  host.classList.add('open');

  /** 上层弹层打开时，把下面的层压暗一点，做出层次感 */
  const refreshDepth = () => {
    const layers = [...host.children];
    layers.forEach((el, i) => el.classList.toggle('behind', i < layers.length - 1));
  };
  refreshDepth();
  // 下一帧再加 .show，保证滑入动画能正常播放
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('show')));

  const close = () => {
    try {
      onClose?.();
    } catch {
      /* 关闭时的保存动作失败不该影响关闭本身 */
    }
    layer.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => {
      layer.remove();
      refreshDepth();
      if (!host.children.length) host.classList.remove('open');
    }, 300);
  };
  // 只关闭最上面那一层
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (host.lastElementChild !== layer) return;
    close();
  };
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  // 下拉关闭
  let startY = null;
  handle.addEventListener(
    'touchstart',
    (e) => {
      startY = e.touches[0].clientY;
      sheet.style.transition = 'none';
    },
    { passive: true }
  );
  handle.addEventListener(
    'touchmove',
    (e) => {
      if (startY === null) return;
      const dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    },
    { passive: true }
  );
  handle.addEventListener('touchend', (e) => {
    const dy = startY === null ? 0 : e.changedTouches[0].clientY - startY;
    sheet.style.transition = '';
    sheet.style.transform = '';
    startY = null;
    if (dy > 90) close();
  });

  return { close, root: sheet, body };
}

export function confirmDialog({ title, message, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const confirmBtn = h(danger ? 'button.danger-btn' : 'button.primary-btn', confirmText);
    const cancelBtn = h('button.ghost-btn', cancelText);
    confirmBtn.type = 'button';
    cancelBtn.type = 'button';
    const sheet = openSheet({
      title,
      subtitle: message,
      content: h('div'),
      actions: [cancelBtn, confirmBtn],
    });
    cancelBtn.addEventListener('click', () => {
      sheet.close();
      resolve(false);
    });
    confirmBtn.addEventListener('click', () => {
      sheet.close();
      resolve(true);
    });
  });
}

export function field(label, control, hint) {
  return h('div.field', [h('label', label), control, hint ? h('div.hint', hint) : null]);
}

export function segmented(options, activeValue, onPick) {
  const wrap = h('div.seg');
  for (const opt of options) {
    const btn = h('button', { type: 'button', dataset: { active: String(opt.value === activeValue) } }, opt.label);
    btn.addEventListener('click', () => onPick(opt.value));
    wrap.append(btn);
  }
  return wrap;
}

/** 复制到剪贴板：不支持 Clipboard API 的 http 环境下退回到 selection 方案 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续尝试兜底方案 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
