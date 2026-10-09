/* 旅行计划：卡片列表 + Day 分格编辑子页面 */
import { sync } from '../sync.js';
import { openSheet, toast, confirmDialog, field, segmented } from '../ui.js';
import { openDatePicker } from '../datepicker.js';
import { h, uid, fmtRange, money, isKey, parseKey, addDaysKey, fmtDate, debounce, CN_WEEK } from '../util.js';

const CURRENCIES = ['CNY', 'HKD', 'USD'];

const tripDays = (trip) => (Array.isArray(trip.days) && trip.days.length ? trip.days : [{ id: uid(), title: '', note: '' }]);

/**
 * 让 textarea 高度跟着内容走：显示全部行，不出现内部滚动条。
 * 必须在元素插入 DOM 之后调用（scrollHeight 才有意义）。
 */
function autoGrow(el) {
  const resize = () => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  el.addEventListener('input', resize);
  el.classList.add('autogrow');
  requestAnimationFrame(resize);
  return resize;
}

/** 屏幕旋转 / 窗口变化后，换行数会变，重新算一遍所有自增高输入框 */
globalThis.addEventListener('resize', () => {
  for (const el of document.querySelectorAll('textarea.autogrow')) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }
});

const sortTrips = (trips) =>
  [...trips].sort((a, b) => {
    const ka = a.startDate ?? '9999-12-31';
    const kb = b.startDate ?? '9999-12-31';
    if (ka !== kb) return ka < kb ? -1 : 1;
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  });

function tripCard(trip, ctx) {
  const days = tripDays(trip);
  const chips = [h('span.chip.blue', `🚩 ${days.length} 天`)];
  const price = money(trip.budget, trip.currency);
  if (price) chips.push(h('span.chip.green', `💰 ${price}`));
  const range = fmtRange(trip.startDate, days.length);
  if (range) chips.push(h('span.chip', `📅 ${range}`));

  const card = h('button.trip-card', { type: 'button' }, [
    h('h3', [`🗺️ ${trip.destination || '未命名旅行'}`]),
    h('div.trip-meta', chips),
    trip.note ? h('div.muted', { style: { marginTop: '8px' } }, trip.note) : null,
  ]);
  card.addEventListener('click', () => ctx.go(`/trips/${trip.id}`));
  return card;
}

/* ------------------------------ 新建旅行计划 ------------------------------ */

function openNewTripSheet(ctx) {
  const nameInput = h('input', { type: 'text', placeholder: '例如：京都赏樱', maxlength: '60' });
  let startDate = null;
  const dateBtn = h('button.date-btn', { type: 'button', dataset: { empty: 'true' } }, '未设置 · 点这里选出发日期');
  const syncDateBtn = () => {
    dateBtn.dataset.empty = String(!startDate);
    dateBtn.textContent = startDate ? fmtDate(startDate, { withYear: true, withWeek: true }) : '未设置 · 点这里选出发日期';
  };
  dateBtn.addEventListener('click', () =>
    openDatePicker({
      title: '出发日期',
      value: startDate ?? '',
      onPick: (key) => {
        startDate = key;
        syncDateBtn();
      },
      onClear: () => {
        startDate = null;
        syncDateBtn();
      },
    })
  );
  const budgetInput = h('input', { type: 'number', inputmode: 'decimal', placeholder: '可不填', min: '0', step: '100' });
  const noteInput = h('input', { type: 'text', placeholder: '可选，比如：和爸妈一起', maxlength: '100' });

  let dayCount = 3;
  const valEl = h('span.val', `${dayCount} 天`);
  const stepper = h('div.stepper', [
    h('button', { type: 'button', onclick: () => setCount(-1) }, '−'),
    valEl,
    h('button', { type: 'button', onclick: () => setCount(1) }, '＋'),
  ]);
  function setCount(delta) {
    dayCount = Math.min(60, Math.max(1, dayCount + delta));
    valEl.textContent = `${dayCount} 天`;
  }

  const save = h('button.primary-btn', { type: 'button' }, '创建旅行计划');
  save.addEventListener('click', async () => {
    const destination = nameInput.value.trim();
    if (!destination) {
      toast('先写个目的地吧');
      nameInput.focus();
      return;
    }
    const id = uid();
    const trip = {
      id,
      destination,
      startDate,
      budget: budgetInput.value === '' ? null : Number(budgetInput.value),
      currency: 'CNY',
      note: noteInput.value.trim(),
      days: Array.from({ length: dayCount }, () => ({ id: uid(), title: '', note: '' })),
      createdBy: sync.me,
    };
    close();
    await sync.dispatch({ kind: 'trip.create', trip });
    toast('已创建，去填每天的安排吧');
    ctx.go(`/trips/${id}`);
  });

  const { close } = openSheet({
    title: '新的旅行计划',
    subtitle: '先定好目的地和天数，细节以后再补',
    content: [
      field('目的地', nameInput),
      field('出发日期（可选）', dateBtn, '填了之后每天会自动显示对应日期'),
      field('计划天数', stepper),
      field('预计经费（可选）', budgetInput, '单位人民币，之后还能改'),
      field('备注（可选）', noteInput),
      save,
    ],
  });
}

/* -------------------------------- 列表页 -------------------------------- */

export const TripsView = {
  topbar: () => ({ title: '✈️ 旅行计划' }),

  render(root, _params, ctx) {
    const trips = sortTrips(sync.state.trips ?? []);
    root.append(
      h('button.primary-btn', { type: 'button', onclick: () => openNewTripSheet(ctx) }, '＋ 新建旅行计划')
    );

    if (!trips.length) {
      root.append(h('div.empty', ['还没有旅行计划', h('br'), '点上面的按钮，把想去的地方记下来吧 ❤️']));
      return;
    }

    root.append(h('div.section-title', `共 ${trips.length} 个计划`));
    for (const trip of trips) root.append(tripCard(trip, ctx));
  },
};

/* ------------------------------- 详情子页面 ------------------------------- */

export const TripDetailView = {
  topbar: (params) => ({ title: '旅行计划', back: '/trips' }),

  render(root, params, ctx) {
    const trip = (sync.state.trips ?? []).find((t) => t.id === params.id);
    if (!trip) {
      root.append(h('div.empty', ['这个旅行计划不存在了', h('br'), '可能已被删除']));
      return;
    }

    const destination = h('input', { type: 'text', value: trip.destination ?? '', maxlength: '60' });
    let startDateValue = trip.startDate ?? null;
    const startDateBtn = h('button.date-btn', { type: 'button' }, '');
    const syncDateBtn = () => {
      startDateBtn.dataset.empty = String(!startDateValue);
      startDateBtn.textContent = startDateValue
        ? fmtDate(startDateValue, { withYear: true, withWeek: true })
        : '未设置 · 点这里选出发日期';
    };
    syncDateBtn();
    startDateBtn.addEventListener('click', () =>
      openDatePicker({
        title: '出发日期',
        value: startDateValue ?? '',
        onPick: (key) => {
          startDateValue = key;
          syncDateBtn();
          save();
        },
        onClear: () => {
          startDateValue = null;
          syncDateBtn();
          save();
        },
      })
    );
    const budget = h('input', {
      type: 'number',
      inputmode: 'decimal',
      value: trip.budget ?? '',
      placeholder: '可不填',
      min: '0',
      step: '100',
    });
    const currency = h('select', CURRENCIES.map((c) => h('option', { value: c, selected: (trip.currency ?? 'CNY') === c }, c)));
    const note = h('textarea', {
      value: trip.note ?? '',
      placeholder: '整体安排、想带的东西、机票酒店信息…',
      maxlength: '200',
    });
    autoGrow(note); // 行数多了要能看全，不出现内部滚动条

    const save = debounce(() => {
      sync.dispatch({
        kind: 'trip.update',
        id: trip.id,
        patch: {
          destination: destination.value.trim(),
          startDate: startDateValue,
          budget: budget.value === '' ? null : Number(budget.value),
          currency: currency.value,
          note: note.value.trim(),
        },
      });
    }, 600);
    for (const node of [destination, budget, currency, note]) {
      node.addEventListener('input', save);
      node.addEventListener('change', save);
    }

    const days = tripDays(trip);
    const dayNodes = days.map((day, index) => {
      const badge = h('span.day-badge', `Day ${index + 1}`);
      const dateLabel = trip.startDate && isKey(trip.startDate)
        ? h('span.date', (() => {
            const key = addDaysKey(trip.startDate, index);
            return `${fmtDate(key)} ${CN_WEEK[parseKey(key).getDay()]}`;
          })())
        : null;
      const del = h('button.icon-btn.danger', { type: 'button', title: '删除这一天' }, '✕');
      const textarea = h('textarea', {
        placeholder: index === 0 ? '第一天：几点出发？住哪？想吃什么？' : '这一天的安排…',
        value: day.note ?? '',
      });
      autoGrow(textarea); // 当天安排写多了也要能看全
      const titleInput = h('input', {
        type: 'text',
        value: day.title ?? '',
        placeholder: `Day ${index + 1} 的小标题（可选）`,
        maxlength: '60',
        style: { marginBottom: '8px', padding: '9px 10px', borderRadius: '12px', border: '1px solid var(--line)', background: '#fffdfe', width: '100%' },
      });

      const persist = debounce(() => {
        const list = tripDays(sync.state.trips.find((t) => t.id === trip.id) ?? trip);
        const next = list.map((d) => (d.id === day.id ? { ...d, title: titleInput.value, note: textarea.value } : d));
        sync.dispatch({ kind: 'trip.update', id: trip.id, patch: { days: next } });
      }, 600);
      titleInput.addEventListener('input', persist);
      textarea.addEventListener('input', persist);

      del.addEventListener('click', async () => {
        if (days.length <= 1) return toast('至少保留一天');
        const ok = await confirmDialog({ title: `删除 Day ${index + 1}？`, message: '这天的安排会被移除', confirmText: '删除', danger: true });
        if (!ok) return;
        const list = tripDays(sync.state.trips.find((t) => t.id === trip.id) ?? trip);
        sync.dispatch({ kind: 'trip.update', id: trip.id, patch: { days: list.filter((d) => d.id !== day.id) } });
        ctx.refresh();
      });

      return h('div.day-block', [
        h('header', [badge, dateLabel, h('span', { style: { flex: '1' } }), del]),
        titleInput,
        textarea,
      ]);
    });

    const addDay = h('button.add-day', { type: 'button' }, [h('span.plus', '＋'), '添加一天']);
    addDay.addEventListener('click', () => {
      const list = tripDays(sync.state.trips.find((t) => t.id === trip.id) ?? trip);
      sync.dispatch({ kind: 'trip.update', id: trip.id, patch: { days: [...list, { id: uid(), title: '', note: '' }] } });
      toast(`已加入 Day ${list.length + 1}`);
      // 新增的输入框要等重绘后出现，稍微延迟滚动到底部
      ctx.refresh();
      setTimeout(() => globalThis.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 60);
    });

    const delTrip = h('button.danger-btn', { type: 'button' }, '删除整个旅行计划');
    delTrip.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '删除这个旅行计划？',
        message: `${trip.destination || '未命名'} 的所有 Day 安排都会消失`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      await sync.dispatch({ kind: 'trip.delete', id: trip.id });
      toast('已删除');
      ctx.go('/trips');
    });

    const countChip = h('span.chip.blue', `${days.length} 天`);
    const rangeChip = trip.startDate && isKey(trip.startDate) ? h('span.chip', fmtRange(trip.startDate, days.length)) : null;

    root.append(
      h('div.card', [
        h('div', { style: { display: 'flex', gap: '6px', marginBottom: '12px', alignItems: 'center' } }, [
          countChip,
          rangeChip,
          h('span', { style: { flex: '1' } }),
        ]),
        field('目的地', destination),
        field('出发日期（可选）', startDateBtn),
        h('div.field', [h('label', '预计经费（可选）'), h('div.row', [budget, currency])]),
        h('div.hint', '改动会自动保存，TA 那边马上就能看到 ✨'),
      ]),
      // 总体计划：独立一块，放在 Day 1 之前，写整趟行程的安排
      h('div.card.plan-card', [
        h('div.plan-head', [h('span.plan-badge', '总体计划'), h('span.muted', '不跟着某一天，写整趟的安排')]),
        note,
      ]),
      h('div.section-title', `行程安排 · ${days.length} 天`),
      ...dayNodes,
      addDay,
      h('div.action-row', { style: { marginTop: '22px' } }, [delTrip])
    );
  },
};
