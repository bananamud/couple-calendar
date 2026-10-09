/* 通用工具：日期、DOM、格式化 */

export const pad = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD'（按本地时区，避免 UTC 偏移） */
export const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 'YYYY-MM-DD' -> Date（本地 0 点） */
export function parseKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export const isKey = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

export const addDaysKey = (key, n) => toKey(addDays(parseKey(key), n));

export const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** 周一为一周的第一天 */
export const mondayIndex = (d) => (d.getDay() + 6) % 7;

export const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

export const monthDays = (year, month) => new Date(year, month + 1, 0).getDate();

/**
 * 生成某月的日历矩阵（整周补全，周一开头）
 * @param {{weeks?:number}} [opts] weeks=6 时固定输出 6 行（日期选择器用，避免高度跳变）
 */
export function monthMatrix(year, month, opts = {}) {
  const first = new Date(year, month, 1);
  const lead = mondayIndex(first);
  const total = monthDays(year, month);
  const cells = [];
  for (let i = lead; i > 0; i--) cells.push(addDays(first, -i));
  for (let d = 1; d <= total; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(addDays(cells[cells.length - 1], 1));
  const target = opts.weeks ? opts.weeks * 7 : 35;
  while (cells.length < target) cells.push(addDays(cells[cells.length - 1], 1));
  return cells;
}

export const CN_WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function fmtDate(key, { withWeek = false, withYear = false } = {}) {
  const d = parseKey(key);
  const base = withYear
    ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getMonth() + 1}月${d.getDate()}日`;
  return withWeek ? `${base} ${CN_WEEK[d.getDay()]}` : base;
}

export function fmtRange(startKey, dayCount) {
  if (!isKey(startKey) || !dayCount) return null;
  const end = addDaysKey(startKey, dayCount - 1);
  const s = parseKey(startKey);
  const e = parseKey(end);
  const sameMonth = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth();
  if (dayCount === 1) return fmtDate(startKey);
  return sameMonth
    ? `${s.getMonth() + 1}月${s.getDate()}日 - ${e.getDate()}日`
    : `${fmtDate(startKey)} - ${fmtDate(end)}`;
}

export const money = (v, currency = 'CNY') => {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return null;
  const symbol = currency === 'HKD' ? 'HK$' : currency === 'USD' ? '$' : '¥';
  const n = Number(v);
  return `${symbol}${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
};

export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/* --------------------------------- DOM --------------------------------- */

/**
 * h('div.card', { onclick }, [children])
 * 标签支持 'div.a.b#id' 简写。
 */
export function h(spec, attrs, children) {
  // h('div', '文字')：第二个参数是内容
  if (children === undefined && attrs && (Array.isArray(attrs) || typeof attrs === 'string' || attrs instanceof Node)) {
    children = attrs;
    attrs = null;
  }
  // h('button', 'danger-btn', '删除')：第二个参数是 class（防止把类名渲染成文字）
  if (typeof attrs === 'string' && children !== undefined) attrs = { class: attrs };
  if (attrs instanceof Node || Array.isArray(attrs)) attrs = null;
  const [tagPart, ...classes] = String(spec).split('.');
  const [tag, id] = tagPart.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = [node.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }

  const list = children === undefined ? [] : Array.isArray(children) ? children : [children];
  for (const child of list.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * 安全的批量追加：自动跳过 null / undefined / false。
 * （原生 Node.append(null) 会插入文字 "null"，踩过两次坑，统一走这里）
 */
export function append(parent, ...children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export const svgIcon = (path, { fill = 'none' } = {}) =>
  h('span', { html: `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%">${path}</svg>` });

export const debounce = (fn, wait = 400) => {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
};
