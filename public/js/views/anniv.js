/* 纪念日：每年自动重复标记 + Days Matter 风格的正数/倒数 */
import { sync } from '../sync.js';
import { openSheet, toast, confirmDialog, field, segmented } from '../ui.js';
import { openDatePicker } from '../datepicker.js';
import { h, append, uid, fmtDate, parseKey, toKey, isKey, CN_WEEK } from '../util.js';

const EMOJIS = ['❤️', '💍', '🎂', '🌹', '🎉', '✨', '🏠', '🐱', '🍰', '🎁'];

function daysBetween(fromKey, toKeyStr) {
  const a = parseKey(fromKey).getTime();
  const b = parseKey(toKeyStr).getTime();
  return Math.round((b - a) / 86400000);
}

/** 下一次发生的日期与「第几周年」 */
export function nextOccurrence(anniv, from = new Date()) {
  if (!isKey(anniv.date)) return null;
  const fromKey = toKey(from);
  if (anniv.repeat === 'once') {
    return { key: anniv.date, nth: null, diff: daysBetween(fromKey, anniv.date) };
  }
  const [y, m, d] = anniv.date.split('-').map(Number);
  let year = from.getFullYear();
  let key = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (key < fromKey) {
    year += 1;
    key = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return { key, nth: year - y + 1, diff: daysBetween(fromKey, key) };
}

/** 正数（已经过了多少天）与倒数（还有多少天） */
export function annivNumbers(anniv) {
  const todayKey = toKey(new Date());
  const since = isKey(anniv.date) ? daysBetween(anniv.date, todayKey) : 0;
  const next = nextOccurrence(anniv);
  return {
    since,                          // 正数：从原始日期到今天
    countdown: next ? next.diff : null, // 倒数：距下一次（可能为 0）
    next,
  };
}

const dayWord = (n) => `${n} 天`;

let reorderMode = false; // 是否处于「排序模式」（显式进入，每条左侧出现手柄）

const gripIcon = () =>
  h('span.drag-handle', {
    'aria-label': '拖动排序',
    html: `<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <circle cx="5.5" cy="4" r="1.4"/><circle cx="10.5" cy="4" r="1.4"/>
      <circle cx="5.5" cy="8" r="1.4"/><circle cx="10.5" cy="8" r="1.4"/>
      <circle cx="5.5" cy="12" r="1.4"/><circle cx="10.5" cy="12" r="1.4"/>
    </svg>`,
  });

/**
 * 排序模式下的拖动：按住左侧手柄立即开始拖（不用长按）。
 * 手柄设了 touch-action: none，所以不会和页面滚动抢手势；
 * 拖到屏幕上下边缘时会自动滚动，方便长列表。
 */
function enableHandleDrag(card, ctx) {
  const items = () => [...card.querySelectorAll('.list-item')];
  let dragging = null;
  let moved = false;

  const onMove = (event) => {
    if (!dragging) return;
    moved = true;
    const y = event.clientY;
    const margin = 80;
    if (y < margin) window.scrollBy(0, -14);
    else if (y > window.innerHeight - margin) window.scrollBy(0, 14);

    let list = items();
    let index = list.indexOf(dragging);
    while (index > 0) {
      const prev = list[index - 1];
      const box = prev.getBoundingClientRect();
      if (y >= box.top + box.height / 2) break;
      prev.before(dragging);
      list = items();
      index = list.indexOf(dragging);
    }
    while (index < list.length - 1) {
      const next = list[index + 1];
      const box = next.getBoundingClientRect();
      if (y <= box.top + box.height / 2) break;
      next.after(dragging);
      list = items();
      index = list.indexOf(dragging);
    }
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    if (!dragging) return;
    dragging.classList.remove('dragging');
    card.classList.remove('dragging-active');
    dragging = null;
    if (moved) {
      sync.dispatch({ kind: 'anniv.reorder', ids: items().map((n) => n.dataset.id) });
      toast('顺序已保存');
    }
  };

  for (const handle of card.querySelectorAll('.drag-handle')) {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const item = handle.closest('.list-item');
      if (!item) return;
      dragging = item;
      moved = false;
      item.classList.add('dragging');
      card.classList.add('dragging-active');
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* 某些浏览器不支持也无妨，事件仍会冒泡到 window */
      }
      try {
        navigator.vibrate?.(10);
      } catch {
        /* ignore */
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
      window.addEventListener('pointercancel', onUp, { once: true });
    });
  }
}

/* ------------------------------ 编辑弹层 ------------------------------ */

function openAnnivSheet(anniv, ctx) {
  const isNew = !anniv;
  let emoji = anniv?.emoji ?? '❤️';
  let repeat = anniv?.repeat ?? 'yearly';
  let dateValue = anniv?.date ?? toKey(new Date());

  const titleInput = h('input', { type: 'text', value: anniv?.title ?? '', placeholder: '例如：在一起的第一天', maxlength: '40' });
  const dateBtn = h('button.date-btn', { type: 'button' });
  const syncDateBtn = () => {
    dateBtn.dataset.empty = String(!dateValue);
    dateBtn.textContent = dateValue ? fmtDate(dateValue, { withYear: true, withWeek: true }) : '选择日期';
  };
  syncDateBtn();
  dateBtn.addEventListener('click', () =>
    openDatePicker({
      title: '选择纪念日日期',
      value: dateValue,
      onPick: (key) => {
        dateValue = key;
        syncDateBtn();
      },
    })
  );

  const noteInput = h('input', { type: 'text', value: anniv?.note ?? '', placeholder: '可选', maxlength: '100' });

  // 图标：预设 + 自定义（粘贴任意表情 / 短词）
  const isCustomEmoji = () => !EMOJIS.includes(emoji);
  // 固定 4 列：10 个预设排成 4+4+2，最后一行的空位正好放自定义输入框
  const emojiRow = h('div.emoji-grid');
  const customInput = h('input', {
    type: 'text',
    class: 'emoji-custom-input',
    maxlength: '8',
    placeholder: '自定义表情',
    value: isCustomEmoji() ? emoji : '',
    'aria-label': '自定义图标',
  });
  const syncEmojiActive = () => {
    [...emojiRow.children].forEach((c, i) => c.setAttribute('data-active', String(!isCustomEmoji() && EMOJIS[i] === emoji)));
    customInput.dataset.active = String(isCustomEmoji());
  };
  for (const e of EMOJIS) {
    const btn = h('button', { type: 'button', dataset: { active: String(e === emoji) } }, e);
    btn.addEventListener('click', () => {
      emoji = e;
      customInput.value = '';
      syncEmojiActive();
    });
    emojiRow.append(btn);
  }
  emojiRow.append(customInput);
  customInput.addEventListener('input', () => {
    const value = customInput.value.trim();
    if (value) emoji = value;
    else emoji = '❤️'; // 清空就回到默认
    syncEmojiActive();
  });
  syncEmojiActive();

  const repeatSeg = h('div.seg');
  const renderRepeat = () => {
    repeatSeg.innerHTML = '';
    for (const opt of [
      { value: 'yearly', label: '每年重复' },
      { value: 'once', label: '只记这一次' },
    ]) {
      const btn = h('button', { type: 'button', dataset: { active: String(opt.value === repeat) } }, opt.label);
      btn.addEventListener('click', () => {
        repeat = opt.value;
        renderRepeat();
      });
      repeatSeg.append(btn);
    }
  };
  renderRepeat();

  const save = h('button.primary-btn', { type: 'button' }, isNew ? '添加纪念日' : '保存修改');
  save.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) return toast('给这个日子起个名字吧');
    if (!isKey(dateValue)) return toast('请选择日期');
    if (isNew) {
      await sync.dispatch({
        kind: 'anniv.create',
        anniv: { id: uid(), title, date: dateValue, emoji, repeat, note: noteInput.value.trim() },
      });
    } else {
      await sync.dispatch({
        kind: 'anniv.update',
        id: anniv.id,
        patch: { title, date: dateValue, emoji, repeat, note: noteInput.value.trim() },
      });
    }
    toast(isNew ? '已记下这个日子 ❤️' : '已更新');
    close();
    ctx.refresh();
  });

  const actions = [];
  if (!isNew) {
    actions.push(
      h(
        'button.danger-btn',
        {
          type: 'button',
          onclick: async () => {
            const ok = await confirmDialog({ title: '删除这个纪念日？', message: anniv.title, confirmText: '删除', danger: true });
            if (!ok) return;
            await sync.dispatch({ kind: 'anniv.delete', id: anniv.id });
            toast('已删除');
            close();
            ctx.go('/anniv');
          },
        },
        '删除'
      )
    );
  }
  actions.push(h('button.ghost-btn', { type: 'button', onclick: () => close() }, '取消'));

  const { close } = openSheet({
    title: isNew ? '新的纪念日' : '编辑纪念日',
    subtitle: '设成每年重复后，日历上每年这一天都会有标记',
    content: [
      field('名称', titleInput),
      field('日期', dateBtn, '点击修改'),
      field('图标', emojiRow),
      field('重复方式', repeatSeg),
      field('备注（可选）', noteInput),
      save,
    ],
    actions,
  });
}

/* -------------------------------- 列表页 -------------------------------- */

export const AnnivView = {
  topbar: () => ({ title: '💞 纪念日' }),

  render(root, _params, ctx) {
    // 拖动排过序就按保存的顺序，没排过的按日期（月-日）
    const list = [...(sync.state.anniversaries ?? [])].sort((a, b) => {
      const oa = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
      const ob = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return String(a.date ?? '').slice(5).localeCompare(String(b.date ?? '').slice(5));
    });

    const modeBtn = h(
      'button.ghost-btn.sort-toggle',
      {
        type: 'button',
        onclick: () => {
          reorderMode = !reorderMode;
          ctx.refresh();
        },
      },
      reorderMode ? '完成' : '排序'
    );
    if (reorderMode) {
      root.append(h('div.sort-tip', '按住每条左侧的 ⋮⋮ 手柄上下拖动，调整完点「完成」'));
      root.append(modeBtn);
    } else {
      root.append(
        h('div', { style: { display: 'flex', gap: '8px' } }, [
          h('button.primary-btn', { type: 'button', onclick: () => openAnnivSheet(null, ctx) }, '＋ 添加纪念日'),
          list.length >= 2 ? modeBtn : null,
        ])
      );
    }

    if (!list.length) {
      root.append(h('div.empty', ['还没有纪念日', h('br'), '在一起的日期、生日、领证日…都记下来吧']));
      return;
    }

    const card = h('div.card', { style: { marginTop: '14px' } });
    for (const anniv of list) {
      const { since, countdown, next } = annivNumbers(anniv);
      const meta = [
        `${fmtDate(anniv.date, { withYear: true })}${anniv.repeat === 'yearly' ? ' 起 · 每年重复' : ` ${CN_WEEK[parseKey(anniv.date).getDay()]}`}`,
      ];

      const numbers = h('div', { style: { marginTop: '4px', display: 'flex', gap: '10px', fontSize: '12.5px' } }, [
        since >= 0
          ? h('span', { style: { color: 'var(--ink-2)' } }, [
              '正数 ',
              h('b', { style: { color: 'var(--u1)' } }, dayWord(since)),
            ])
          : h('span', { style: { color: 'var(--ink-2)' } }, [
              '正数 ',
              h('b', { style: { color: 'var(--ink-3)' } }, '还没到'),
            ]),
        countdown === null
          ? null
          : h('span', { style: { color: 'var(--ink-2)' } }, [
              '倒数 ',
              h('b', { style: { color: 'var(--u2)' } }, countdown === 0 ? '就是今天 🎉' : dayWord(countdown)),
            ]),
      ]);

      const item = h('div.list-item', { role: 'button', tabindex: '0', dataset: { id: anniv.id } }, [
        reorderMode ? gripIcon() : null,
        h('div.emoji', anniv.emoji || '❤️'),
        h('div.grow', [
          h('div.t', [
            anniv.title,
            next?.nth ? h('span.muted', ` 第 ${next.nth} 年`) : null,
          ]),
          h('div.s', meta.join(' · ')),
          numbers,
          anniv.note ? h('div.s', { style: { marginTop: '2px' } }, anniv.note) : null,
        ]),
        reorderMode ? null : h('span.muted', '›'),
      ]);
      item.addEventListener('click', () => {
        if (reorderMode) return; // 排序模式下点条目不进详情，避免误触
        ctx.go(`/anniv/${anniv.id}`);
      });
      card.append(item);
    }
    if (reorderMode) {
      card.classList.add('anniv-list', 'reordering');
      enableHandleDrag(card, ctx);
    }
    root.append(card);
  },
};

/* ------------------------------- 详情子页面 ------------------------------- */

export const AnnivDetailView = {
  topbar: () => ({ title: '纪念日', back: '/anniv' }),

  render(root, params, ctx) {
    const anniv = (sync.state.anniversaries ?? []).find((a) => a.id === params.id);
    if (!anniv) {
      root.append(h('div.empty', ['这个纪念日不存在了', h('br'), '可能已被删除']));
      return;
    }

    const { since, countdown, next } = annivNumbers(anniv);
    let mode = countdown !== null && countdown > 0 ? 'countdown' : 'since';

    const heroNum = h('div.hero-num');
    const heroSub = h('div.hero-sub');
    const renderHero = () => {
      const value = mode === 'countdown' ? countdown : since;
      heroNum.innerHTML = '';
      heroNum.append(String(value), h('span.unit', '天'));
      if (mode === 'countdown') {
        heroSub.textContent = countdown === 0 ? '就是今天 🎉' : `距离「${anniv.title}」还有`;
      } else {
        heroSub.textContent = anniv.repeat === 'yearly' ? `从这一天起，已经走过` : '已经过去';
      }
    };
    renderHero();

    const hero = h('div.hero', { role: 'button', tabindex: '0' }, [
      h('div.hero-emoji', anniv.emoji || '❤️'),
      h('div.hero-title', anniv.title),
      heroNum,
      heroSub,
      h('div.hero-date', `${fmtDate(anniv.date, { withYear: true })} ${CN_WEEK[parseKey(anniv.date).getDay()]}`),
      countdown === null ? null : h('div.hero-tip', '点一下可以切换正数 / 倒数'),
    ]);
    hero.addEventListener('click', () => {
      if (countdown === null) return;
      mode = mode === 'countdown' ? 'since' : 'countdown';
      renderHero();
    });

    const stat = (label, value, color) =>
      h('div.stat-cell', [
        h('b', { style: { color } }, String(value)),
        h('span', label),
      ]);

    const editBtn = h('button.primary-btn', { type: 'button' }, '编辑');
    editBtn.addEventListener('click', () => openAnnivSheet(anniv, ctx));

    const delBtn = h('button.danger-btn', { type: 'button' }, '删除');
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '删除这个纪念日？',
        message: anniv.title,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      await sync.dispatch({ kind: 'anniv.delete', id: anniv.id });
      toast('已删除');
      ctx.go('/anniv');
    });

    append(
      root,
      hero,
      h('div.anniv-stats', [
        since >= 0 ? stat('正数（已经过了）', since, 'var(--u1)') : h('div.stat-cell', [h('b', { style: { color: 'var(--ink-3)' } }, '—'), h('span', '正数：还没到')]),
        countdown === null ? h('div.stat-cell', [h('b', '—'), h('span', '只记这一次')]) : stat('倒数（还有）', countdown, 'var(--u2)'),
      ]),
      anniv.note ? h('div.card', [h('div.muted', '备注'), h('div', { style: { marginTop: '4px' } }, anniv.note)]) : null,
      h('div.action-row', [delBtn, editBtn])
    );
  },
};
