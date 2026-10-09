/* 启动、路由与全局刷新 */
import { sync } from './sync.js';
import { loadHolidays, setPredict } from './holidays.js';
import { CalendarView } from './views/calendar.js';
import { TripsView, TripDetailView } from './views/trips.js';
import { AnnivView, AnnivDetailView } from './views/anniv.js';
import { MeView } from './views/me.js';
import { h, debounce } from './util.js';
import { toast } from './ui.js';

const ROUTES = [
  { match: (p) => p.length === 0 || p[0] === 'calendar', view: CalendarView, tab: 'calendar' },
  { match: (p) => p[0] === 'trips' && p.length === 1, view: TripsView, tab: 'trips' },
  { match: (p) => p[0] === 'trips' && p.length >= 2, view: TripDetailView, tab: 'trips', params: (p) => ({ id: p[1] }) },
  { match: (p) => p[0] === 'anniv' && p.length >= 2, view: AnnivDetailView, tab: 'anniv', params: (p) => ({ id: p[1] }) },
  { match: (p) => p[0] === 'anniv', view: AnnivView, tab: 'anniv' },
  { match: (p) => p[0] === 'me', view: MeView, tab: 'me' },
];

const topbar = document.getElementById('topbar');
const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');

const segments = () => {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  return raw.split('/').filter(Boolean);
};

const current = () => {
  const p = segments();
  return ROUTES.find((r) => r.match(p)) ?? ROUTES[0];
};

const ctx = {
  go(route) {
    location.hash = `#${route}`;
  },
  refresh() {
    render({ preserveScroll: true });
  },
};

function syncPill() {
  const map = { ok: '已同步', busy: '同步中', connecting: '连接中', off: '离线', locked: '需配对' };
  const pill = h('button.sync-pill', { type: 'button', dataset: { state: sync.status } }, [
    h('span.dot'),
    map[sync.status] ?? sync.status,
  ]);
  pill.addEventListener('click', async () => {
    try {
      await sync.syncNow();
      toast('已是最新');
    } catch {
      if (!sync.authRequired) sync.setStatus('off');
    }
  });
  return pill;
}

/** 没有配对密钥时，给出人话提示而不是空白页面 */
function pairNotice() {
  return h('div.card', { style: { marginTop: '18px' } }, [
    h('div', { style: { fontSize: '17px', fontWeight: '800', marginBottom: '10px' } }, '这个链接缺少访问密钥'),
    h(
      'div',
      { style: { fontSize: '13.5px', lineHeight: '1.9', color: 'var(--ink-2)' } },
      '日历服务开启了公网分享，需要用带密钥的配对链接打开（链接最后有 ?k=… 那段）。'
    ),
    h(
      'div',
      { style: { fontSize: '13.5px', lineHeight: '1.9', color: 'var(--ink-2)', marginTop: '8px' } },
      '请让电脑那边重新发一次配对链接；如果链接完整，点右上角的状态按钮重试。'
    ),
  ]);
}

function buildTopbar(route, params) {
  const spec = route.view.topbar?.(params) ?? { title: '' };
  topbar.innerHTML = '';
  if (spec.back) {
    const back = h('button.back-btn', { type: 'button', 'aria-label': '返回' });
    back.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14.5 5 7.5 12l7 7"/></svg>`;
    back.addEventListener('click', () => ctx.go(spec.back));
    topbar.append(back);
  }
  topbar.append(h('h1', spec.title ?? ''), h('span.spacer'), syncPill());
}

function highlightTab(tabName) {
  for (const a of tabbar.querySelectorAll('.tab')) {
    a.classList.toggle('active', a.dataset.route === tabName);
  }
}

let lastTab = null;

function render({ preserveScroll = false } = {}) {
  const y = preserveScroll ? globalThis.scrollY : 0;
  const params = current();
  const p = segments();
  const viewParams = params.params?.(p) ?? {};

  // 大陆假期是否使用预测版（跟着共享设置走）
  setPredict(sync.state.settings?.cnPredict === true);

  buildTopbar(params, viewParams);
  highlightTab(params.tab);

  view.innerHTML = '';
  delete view.dataset.notice;
  try {
    if (sync.authRequired && params.tab !== 'me') view.append(pairNotice());
    else params.view.render(view, viewParams, ctx);
  } catch (err) {
    console.error(err);
    view.append(h('div.empty', `页面出错了：${err.message}`));
  }

  if (lastTab !== params.tab) {
    lastTab = params.tab;
    globalThis.scrollTo(0, 0);
  } else if (preserveScroll) {
    globalThis.scrollTo(0, y);
  }
}

const isEditing = () => {
  const el = document.activeElement;
  return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && view.contains(el);
};

const laterRefresh = debounce(() => {
  if (!isEditing()) render({ preserveScroll: true });
}, 400);

sync.subscribe((_state, extra) => {
  try {
    if (extra?.remote) {
      const other = sync.state.members?.[sync.other(sync.me)]?.name ?? 'TA';
      toast(`${other} ${extra.remote}`);
    }
    buildTopbar(current(), {});
    highlightTab(current().tab);
    if (isEditing()) return;
    render({ preserveScroll: true });
  } catch (err) {
    console.error('[app] 刷新界面出错：', err);
  }
});

view.addEventListener('focusout', (event) => {
  // 只有「输入框失焦」才需要补一次重绘（把编辑期间跳过的刷新补上）。
  // 点按钮时也会失焦，如果照样重绘，设置页的折叠面板会被整页重建、展开状态全丢。
  const tag = event.target?.tagName ?? '';
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
  laterRefresh();
});
globalThis.addEventListener('hashchange', () => render());

async function boot() {
  await loadHolidays();
  await sync.init();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
