/**
 * 自带的日期选择器。
 * 手机原生的 <input type="date"> 在某些系统上选完月份就结束了，没法接着选「日」，
 * 所以这里用日历网格自己做：上下月/上下年切换 + 直接点某一天。
 */
import { openSheet } from './ui.js';
import { h, monthMatrix, toKey, parseKey, WEEK_LABELS } from './util.js';

export function openDatePicker({ title = '选择日期', value = '', min = '', max = '', onPick, onClear } = {}) {
  const todayKey = toKey(new Date());
  const start = value || todayKey;
  let year = parseKey(start).getFullYear();
  let month = parseKey(start).getMonth();
  let jumpMode = null; // null | 'year' | 'month'：点标题进来的「选年 / 选月」面板
  let jumpStart = Math.floor(year / 12) * 12;

  const label = h('button.picker-title', { type: 'button', 'aria-label': '选择年份和月份' }, '');
  const gridWrap = h('div.picker-body');
  const jumpHead = h('div.picker-jump-head');
  const jumpGrid = h('div.picker-jump-grid');
  const jumpPanel = h('div.picker-jump', { style: { display: 'none' } }, [jumpHead, jumpGrid]);
  const body = h('div');

  function shift(months) {
    if (jumpMode) {
      jumpMode = null;
      renderJump();
    }
    const d = new Date(year, month + months, 1);
    year = d.getFullYear();
    month = d.getMonth();
    renderGrid();
  }

  function renderGrid() {
    label.textContent = `${year}年${month + 1}月`;
    gridWrap.innerHTML = '';

    const head = h('div.weekhead');
    WEEK_LABELS.forEach((text, i) => head.append(h('span', { class: i >= 5 ? 'we' : '' }, text)));

    const grid = h('div.grid.picker-grid');
    // 固定 6 行：不同月份 5/6 行会让弹层高度跳变，手指就没法稳定点箭头
    for (const date of monthMatrix(year, month, { weeks: 6 })) {
      const key = toKey(date);
      const inMonth = date.getMonth() === month;
      const disabled = (min && key < min) || (max && key > max);
      const cell = h(
        'button.day',
        {
          type: 'button',
          dataset: {
            date: key,
            today: String(key === todayKey),
            picked: String(key === value),
          },
        },
        h('span.num', String(date.getDate()))
      );
      if (!inMonth) cell.classList.add('is-out');
      if (disabled) {
        cell.disabled = true;
        cell.classList.add('is-locked');
      } else {
        cell.addEventListener('click', () => {
          onPick?.(key);
          close();
        });
      }
      grid.append(cell);
    }
    gridWrap.append(head, grid);
  }

  /** 选年 / 选月的面板 */
  function renderJump() {
    const showJump = Boolean(jumpMode);
    jumpPanel.style.display = showJump ? '' : 'none';
    gridWrap.style.display = showJump ? 'none' : '';
    jumpHead.innerHTML = '';
    jumpGrid.innerHTML = '';
    // 选年 / 选月时把那排日历箭头藏起来（这时候它们没意义）
    for (const btn of navButtons) btn.style.display = showJump ? 'none' : '';
    if (!showJump) {
      label.textContent = `${year}年${month + 1}月`;
      return;
    }

    const navBack = h('button.picker-nav', { type: 'button', 'aria-label': '返回' }, '‹');
    if (jumpMode === 'year') {
      const prev = h('button.picker-nav', { type: 'button', 'aria-label': '更早的年份' }, '«');
      const next = h('button.picker-nav', { type: 'button', 'aria-label': '更晚的年份' }, '»');
      prev.addEventListener('click', () => {
        jumpStart -= 12;
        renderJump();
      });
      next.addEventListener('click', () => {
        jumpStart += 12;
        renderJump();
      });
      // 只留左右翻页箭头（和右边对称）；想回日历再点一次标题即可
      jumpHead.append(prev, h('span.picker-jump-title', `${jumpStart} - ${jumpStart + 11}`), next);
      for (let y = jumpStart; y < jumpStart + 12; y++) {
        const btn = h('button.picker-jump-item', { type: 'button', dataset: { active: String(y === year) } }, `${y}`);
        btn.addEventListener('click', () => {
          year = y;
          jumpMode = 'month';
          renderJump();
        });
        jumpGrid.append(btn);
      }
    } else {
      navBack.addEventListener('click', () => {
        jumpMode = 'year';
        renderJump();
      });
      jumpHead.append(navBack, h('span.picker-jump-title', `${year} 年 · 选择月份`));
      for (let m = 0; m < 12; m++) {
        const btn = h('button.picker-jump-item', { type: 'button', dataset: { active: String(m === month) } }, `${m + 1} 月`);
        btn.addEventListener('click', () => {
          month = m;
          jumpMode = null;
          renderJump();
          renderGrid();
        });
        jumpGrid.append(btn);
      }
    }
  }

  const navBtn = (text, delta, hint) =>
    h('button.picker-nav', { type: 'button', 'aria-label': hint, onclick: () => shift(delta) }, text);
  const navButtons = [navBtn('«', -12, '上一年'), navBtn('‹', -1, '上个月'), navBtn('›', 1, '下个月'), navBtn('»', 12, '下一年')];

  label.addEventListener('click', () => {
    jumpMode = jumpMode ? null : 'year';
    jumpStart = Math.floor(year / 12) * 12;
    renderJump();
  });

  body.append(
    h('div.picker-head', [navButtons[0], navButtons[1], label, navButtons[2], navButtons[3]]),
    gridWrap,
    jumpPanel
  );

  const actions = [];
  if (onClear) {
    actions.push(
      h(
        'button.ghost-btn',
        {
          type: 'button',
          onclick: () => {
            onClear();
            close();
          },
        },
        '清除'
      )
    );
  }
  actions.push(
    h(
      'button.ghost-btn',
      {
        type: 'button',
        onclick: () => {
          onPick?.(todayKey);
          close();
        },
      },
      '今天'
    ),
    h('button.ghost-btn', { type: 'button', onclick: () => close() }, '取消')
  );

  renderGrid();
  const { close } = openSheet({ title, content: body, actions });
  return { close };
}
