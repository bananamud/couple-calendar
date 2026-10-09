/* 日历主视图：按颜色区分工作日 / 周末 / 两地法定假期 / 各自请假 */
import { sync } from '../sync.js';
import {
  holidayOf,
  shortHolidayName,
  knownYears,
  predictYears,
  isPredictOn,
  REGION_LABEL,
} from '../holidays.js';
import { LEAVE_TYPES } from '../ops.js';
import { openSheet, toast, segmented, field } from '../ui.js';
import {
  h,
  monthMatrix,
  toKey,
  parseKey,
  isWeekend,
  addDaysKey,
  fmtDate,
  WEEK_LABELS,
  CN_WEEK,
  monthDays,
  debounce,
} from '../util.js';

export const MIN_DATE = '2025-01-01';

const cursor = { y: null, m: null };

function ensureCursor() {
  if (cursor.y !== null) return;
  const today = new Date();
  cursor.y = today.getFullYear();
  cursor.m = today.getMonth();
}

/** 计算某天要用的底色、文字色与标签 */
export function dayPalette(dateKey, state) {
  const date = parseKey(dateKey);
  // 每个人按「设置里各自的法定假期地区」查假期，不能写死成人1=大陆、人2=香港
  const region1 = state.members?.u1?.region === 'HK' ? 'HK' : 'CN';
  const region2 = state.members?.u2?.region === 'HK' ? 'HK' : 'CN';
  const cn = holidayOf(region1, dateKey);
  const hk = holidayOf(region2, dateKey);
  const l1 = state.leaves[`u1|${dateKey}`];
  const l2 = state.leaves[`u2|${dateKey}`];
  const weekend = isWeekend(date);
  // 调休上班是「各自地区」的事：大陆有调休，香港没有，
  // 所以 2026-10-10 这种「大陆周六补班、香港照常放假」的日子要按两个人分别算。
  const cnMakeup = !!cn?.makeup;
  const hkMakeup = !!hk?.makeup;
  const u1RestDay = weekend && !cnMakeup;
  const u2RestDay = weekend && !hkMakeup;

  // 对每个人只判断「这天放不放假」：法定假期 / 周末 / 自己请假，都算放假
  const u1Off = Boolean(l1 || cn?.off || u1RestDay);
  const u2Off = Boolean(l2 || hk?.off || u2RestDay);
  // 一个人一种底色：上班＝黄，放假＝各自的淡蓝/淡粉；
  // 两个人颜色不一样（例如大陆周六补班、香港照常放假）就显示双色渐变。
  const u1Color = u1Off ? 'var(--u1-off)' : 'var(--work)';
  const u2Color = u2Off ? 'var(--u2-off)' : 'var(--work)';
  const background =
    u1Color === u2Color
      ? u1Color
      : `linear-gradient(135deg, ${u1Color} 0%, ${u1Color} 42%, ${u2Color} 58%, ${u2Color} 100%)`;

  const color = 'var(--ink)';

  // 格子里的注释：先写请假类型，再写节日名——两者都要保留
  // （例如 10/19 香港重阳节 + 大陆这边请了年假，格子要同时出现「年假」和「重阳」）
  const leaveNames = [...new Set([l1, l2].filter(Boolean).map((l) => LEAVE_TYPES[l.type] ?? '假'))];
  const holidayNames = [
    ...new Set(
      [
        cn?.off ? cn.short ?? shortHolidayName(cn.name) : null,
        hk?.off ? hk.short ?? shortHolidayName(hk.name) : null,
      ].filter(Boolean)
    ),
  ];
  // 格子最多放两行，超出部分在点开后的详情里看
  let lines = [...leaveNames, ...holidayNames].slice(0, 2);
  if (!lines.length) {
    if (cnMakeup || hkMakeup) lines = ['班'];
    else if (u1RestDay || u2RestDay) lines = ['周末'];
  }
  const label = lines.join('/');

  return {
    background,
    color,
    label,
    lines,
    makeup: cnMakeup,
    weekend,
    region1,
    region2,
    hol1: cn,
    hol2: hk,
    u1RestDay,
    u2RestDay,
    u1Off,
    u2Off,
    cn,
    hk,
    l1,
    l2,
    predicted: Boolean(cn?.predicted || hk?.predicted),
    hasLeave: Boolean(l1 || l2),
    both: Boolean(u1Color && u2Color),
  };
}

export function anniversariesOn(dateKey, list) {
  const md = dateKey.slice(5);
  const year = Number(dateKey.slice(0, 4));
  return list
    .filter((a) => (a.repeat === 'once' ? a.date === dateKey : a.date?.slice(5) === md))
    .map((a) => {
      const startYear = Number(a.date?.slice(0, 4));
      const nth = a.repeat === 'once' ? null : year - startYear + 1;
      return { ...a, nth: nth && nth > 0 ? nth : null };
    });
}

/** 今年已经用掉多少天年假（按日历里标成「年假」的天数统计） */
export function annualUsed(uid, year, state) {
  return Object.values(state.leaves ?? {}).filter(
    (l) => l.user === uid && l.type === 'annual' && String(l.date).startsWith(`${year}-`)
  ).length;
}

const annualTotalOf = (member) => (typeof member?.annualTotal === 'number' ? member.annualTotal : null);

/** 设置年假天数（只存总额，剩余 = 总额 − 日历上已标年假天数） */
function openAnnualSheet(uid, ctx) {
  const state = sync.state;
  const member = state.members[uid] ?? {};
  const year = new Date().getFullYear();
  const used = annualUsed(uid, year, state);
  const total = annualTotalOf(member);
  const remainNow = total === null ? 0 : Math.max(0, total - used);

  const input = h('input', {
    type: 'number',
    inputmode: 'decimal',
    step: '0.5',
    min: '0',
    max: '200',
    value: String(remainNow),
  });
  const preview = h('div.hint');
  const refreshPreview = () => {
    const v = Number(input.value);
    preview.textContent =
      input.value !== '' && Number.isFinite(v) && v >= 0
        ? `剩 ${v} 天 · 今年已用 ${used} 天（日历上标成「年假」的天数）· 合计 ${v + used} 天`
        : '请输入 0 以上的数字';
  };
  input.addEventListener('input', refreshPreview);
  refreshPreview();

  const save = h('button.primary-btn', { type: 'button' }, '保存');
  save.addEventListener('click', async () => {
    const v = Number(input.value);
    if (input.value === '' || !Number.isFinite(v) || v < 0) return toast('请输入 0 以上的数字');
    await sync.dispatch({ kind: 'member.update', id: uid, patch: { annualTotal: v + used } });
    toast(`${member.name ?? ''} 的剩余年假已记为 ${v} 天`);
    close();
    ctx.refresh();
  });

  const actions = [];
  if (total !== null) {
    actions.push(
      h(
        'button.ghost-btn',
        {
          type: 'button',
          onclick: async () => {
            await sync.dispatch({ kind: 'member.update', id: uid, patch: { annualTotal: null } });
            toast('已清除');
            close();
            ctx.refresh();
          },
        },
        '清除'
      )
    );
  }
  actions.push(h('button.ghost-btn', { type: 'button', onclick: () => close() }, '取消'));

  const { close } = openSheet({
    title: `${member.name ?? uid} 的年假`,
    subtitle: '填「还剩多少天」就行，日历上再标年假会自动扣掉',
    content: [
      field(`剩余年假天数（${year} 年）`, input),
      preview,
      save,
    ],
    actions,
  });
}

/** 日历下方的年假卡片 */
function annualCards(state, ctx) {
  const year = new Date().getFullYear();
  const wrap = h('div.annual-card');
  for (const uid of ['u1', 'u2']) {
    const member = state.members[uid] ?? {};
    const used = annualUsed(uid, year, state);
    const total = annualTotalOf(member);
    const remain = total === null ? null : total - used;

    const card = h('button.annual', { type: 'button', dataset: { uid } }, [
      h('div.who', [h(`span.swatch.${uid}`), member.name ?? uid]),
      remain === null
        ? h('div.num.unset', '未设置')
        : h('div.num', [String(remain), h('span.unit', '天')]),
      h(
        'div.sub',
        remain === null ? '点这里设置年假' : `剩余年假 · 已用 ${used} / 共 ${total}`
      ),
    ]);
    card.addEventListener('click', () => openAnnualSheet(uid, ctx));
    wrap.append(card);
  }
  wrap.append(h('div.annual-note', `年假按 ${year} 年统计 · 点一下可以修改`));
  return wrap;
}

function monthSummary(year, month, state) {
  const total = monthDays(year, month);
  let u1 = 0;
  let u2 = 0;
  let both = 0;
  for (let d = 1; d <= total; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (key < MIN_DATE) continue;
    const p = dayPalette(key, state);
    const off1 = p.u1Off;
    const off2 = p.u2Off;
    if (off1) u1++;
    if (off2) u2++;
    if (off1 && off2) both++;
  }
  return { u1, u2, both };
}

function dayCell(date, year, month, state, onClick) {
  const key = toKey(date);
  const p = dayPalette(key, state);
  const inMonth = date.getMonth() === month;
  const locked = key < MIN_DATE;
  const anivs = anniversariesOn(key, state.anniversaries ?? []);
  const hasNote = Boolean(p.l1?.note || p.l2?.note);

  const cell = h('button.day', {
    type: 'button',
    style: { background: p.background, color: p.color },
    dataset: {
      date: key,
      today: String(key === toKey(new Date())),
      hasLeave: String(p.hasLeave),
      predicted: String(p.predicted),
      note: String(hasNote),
    },
    'aria-label': `${fmtDate(key, { withYear: true, withWeek: true })}${p.label ? ` ${p.label}` : ''}${
      hasNote ? ` 备注：${[p.l1?.note, p.l2?.note].filter(Boolean).join('；')}` : ''
    }`,
  });
  if (!inMonth) cell.classList.add('is-out');
  if (locked) cell.classList.add('is-locked');

  // 注意：append() 会把 null 转成字符串 "null"，必须先过滤
  cell.append(
    ...[
      h('span.num', String(date.getDate())),
      p.lines.length > 1
        ? h('span.tag.multi', p.lines.map((text) => h('span.tag-line', text)))
        : p.lines.length === 1
          ? h('span.tag', p.lines[0])
          : null,
      hasNote ? h('span.note-mark', '✎') : null,
      anivs.length ? h('span.aniv', anivs[0].emoji || '❤️') : null,
    ].filter(Boolean)
  );
  if (!locked) cell.addEventListener('click', () => onClick(key));
  return cell;
}

/* ------------------------------ 日期详情弹层 ------------------------------ */

export function openDaySheet(dateKey, ctx) {
  const state = sync.state;
  const p = dayPalette(dateKey, state);
  const anivs = anniversariesOn(dateKey, state.anniversaries ?? []);

  let span = 1;

  const describeHoliday = (hol, region, member) => {
    if (!hol) return null;
    const tag = hol.makeup ? '调休上班' : hol.predicted ? '预测，非官方' : '法定假期';
    return `${member?.name ?? REGION_LABEL[region]}（${REGION_LABEL[region]}）· ${hol.name}（${tag}）`;
  };
  const lines = [
    ...new Set(
      [
        describeHoliday(p.hol1, p.region1, state.members.u1),
        describeHoliday(p.hol2, p.region2, state.members.u2),
      ].filter(Boolean)
    ),
  ];
  if (!lines.length) lines.push(p.u1RestDay || p.u2RestDay ? '周末' : '工作日');

  const body = h('div');
  body.append(h('div.sub', lines.join('　·　')));
  // 这天各自是上班还是放假（底色就是按这个来的）
  body.append(
    h(
      'div',
      { style: { display: 'flex', gap: '10px', fontSize: '13px', marginBottom: '14px' } },
      [
        h('span', [h('span.swatch.u1', { style: { verticalAlign: '-2px', marginRight: '5px' } }), `${state.members.u1?.name ?? 'u1'} ${p.u1Off ? '放假' : '上班'}`]),
        h('span', [h('span.swatch.u2', { style: { verticalAlign: '-2px', marginRight: '5px' } }), `${state.members.u2?.name ?? 'u2'} ${p.u2Off ? '放假' : '上班'}`]),
      ]
    )
  );

  if (anivs.length) {
    body.append(
      h(
        'div',
        { style: { marginBottom: '14px' } },
        anivs.map((a) =>
          h('div.chip.pink', { style: { marginRight: '6px', marginBottom: '6px' } },
            `${a.emoji || '❤️'} ${a.title}${a.nth ? ` · 第 ${a.nth} 年` : ''}`)
        )
      )
    );
  }

  // 连续天数
  const valEl = h('span.val', `${span} 天`);
  const spanRow = h('div.stepper', [
    h('button', { type: 'button', onclick: () => changeSpan(-1) }, '−'),
    valEl,
    h('button', { type: 'button', onclick: () => changeSpan(1) }, '＋'),
  ]);
  function changeSpan(delta) {
    span = Math.min(30, Math.max(1, span + delta));
    valEl.textContent = `${span} 天`;
    sub.textContent = span > 1 ? `将影响 ${fmtDate(dateKey)} 起连续 ${span} 天` : '只影响这一天';
  }
  const sub = h('div.hint', '只影响这一天');
  body.append(
    h('div.card', { style: { boxShadow: 'none', background: '#fbf9fc', marginBottom: '14px' } }, [
      h('div', { style: { fontSize: '12.5px', fontWeight: '700', color: 'var(--ink-2)', marginBottom: '8px' } }, '连续天数'),
      spanRow,
      h('div', { style: { marginTop: '8px' } }, sub),
    ])
  );

  const range = () => Array.from({ length: span }, (_, i) => addDaysKey(dateKey, i));

  /** 备注：停止输入 0.7 秒后自动保存（关弹层时也会保存一次） */
  let noteSavers = [];
  async function commitNote(uid, input) {
    const cur = sync.state.leaves[`${uid}|${dateKey}`];
    if (!cur) return;
    const next = input.value.trim().slice(0, 80);
    if (next === (cur.note ?? '')) return;
    await sync.dispatch({ kind: 'leave.set', user: uid, dates: range(), type: cur.type, note: next });
    ctx.refresh();
  }

  const membersWrap = h('div');
  function renderMembers() {
    // 重绘前先取消还没触发的自动保存，避免旧输入框的内容把新状态覆盖回去
    for (const item of noteSavers) item.save.cancel();
    noteSavers = [];
    membersWrap.innerHTML = '';
    for (const uid of ['u1', 'u2']) {
      const member = sync.state.members[uid] ?? {};
      const current = sync.state.leaves[`${uid}|${dateKey}`];
      const isMe = sync.me === uid;

      const chips = h('div.seg');
      for (const [type, label] of Object.entries(LEAVE_TYPES)) {
        const active = current?.type === type;
        const btn = h('button', { type: 'button', dataset: { active: String(active) } }, label);
        btn.addEventListener('click', async () => {
          // 取此刻输入框里的备注（可能刚打完还没自动保存）
          const liveInput = noteSavers.find((n) => n.uid === uid)?.input;
          const liveNote = (liveInput ? liveInput.value : current?.note ?? '').trim().slice(0, 80);
          if (active) {
            await sync.dispatch({ kind: 'leave.remove', user: uid, dates: range() });
            toast(`已取消 ${fmtDate(dateKey)} 的${label}`);
          } else {
            // 换类型时保留已经写好的备注
            await sync.dispatch({
              kind: 'leave.set',
              user: uid,
              dates: range(),
              type,
              note: liveNote,
            });
            toast(`${member.name ?? ''} ${fmtDate(dateKey)} 记为${label}${span > 1 ? ` · 连续 ${span} 天` : ''}`);
          }
          renderMembers();
          ctx.refresh();
        });
        chips.append(btn);
      }

      let noteInput = null;
      if (current) {
        noteInput = h('input', {
          type: 'text',
          class: 'note-input',
          value: current.note ?? '',
          placeholder: '备注（可选）：陪爸妈体检、婚假、提前回家…',
          maxlength: '80',
          'aria-label': '假期备注',
        });
        const save = debounce(() => commitNote(uid, noteInput), 700);
        noteInput.addEventListener('input', save);
        noteInput.addEventListener('blur', () => commitNote(uid, noteInput));
        noteSavers.push({ uid, input: noteInput, save });
      }

      membersWrap.append(
        h('div.card', { style: { boxShadow: 'none', background: '#fbf9fc', marginBottom: '10px' } }, [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } }, [
            h('span', {
              class: `swatch ${uid}`,
              style: { width: '12px', height: '12px', borderRadius: '50%', background: `var(--${uid})` },
            }),
            h('b', `${member.name ?? uid}${isMe ? '（我）' : ''}`),
            h('span.muted', member.region === 'HK' ? '香港假期' : '大陆假期'),
          ]),
          chips,
          noteInput,
          current
            ? h('div', { style: { marginTop: '10px' } }, [
                h(
                  'button.ghost-btn',
                  {
                    type: 'button',
                    onclick: async () => {
                      await sync.dispatch({ kind: 'leave.remove', user: uid, dates: range() });
                      toast('已清除');
                      renderMembers();
                      ctx.refresh();
                    },
                  },
                  `清除这一天的${LEAVE_TYPES[current.type] ?? '假期'}`
                ),
              ])
            : null,
        ])
      );
    }
  }
  renderMembers();
  body.append(membersWrap);

  body.append(
    h('div.hint', [
      '💡 同一个类型再点一次即可取消；两人同一天都有假期时，格子里会显示双色渐变。',
      h('br'),
      `法定节假日数据：中国大陆 ${knownYears('CN').join('、')} · 香港 ${knownYears('HK').join('、')}`,
    ])
  );

  const { close } = openSheet({
    title: fmtDate(dateKey, { withYear: true, withWeek: true }),
    content: body,
    actions: [h('button.ghost-btn', { type: 'button', onclick: () => close() }, '完成')],
    onClose: () => {
      for (const item of noteSavers) commitNote(item.uid, item.input);
    },
  });
}

/* -------------------------------- 视图 -------------------------------- */

export const CalendarView = {
  topbar: () => ({ title: '❤️ 情侣日历' }),

  render(root, _params, ctx) {
    ensureCursor();
    const state = sync.state;
    const { y, m } = cursor;
    const today = new Date();
    const todayKey = toKey(today);

    const canPrev = toKey(new Date(y, m, 1)) > MIN_DATE;
    const cnMissing = !knownYears('CN').includes(String(y));
    const cnPredicted = cnMissing && isPredictOn() && predictYears().includes(String(y));
    const missingData = ['CN', 'HK'].filter((r) => r !== 'CN' && !knownYears(r).includes(String(y)));
    const titleNote = cnPredicted
      ? '大陆放假安排未公布 · 按惯例预测'
      : missingData.length
        ? `${missingData.map((r) => REGION_LABEL[r]).join('/')}放假安排未公布`
        : cnMissing
          ? '大陆放假安排未公布'
          : null;
    const title = h('div.title', [
      `${y}年${m + 1}月`,
      titleNote ? h('small', titleNote) : null,
    ]);

    const shift = (delta) => {
      const d = new Date(y, m + delta, 1);
      if (toKey(d) < MIN_DATE) return;
      cursor.y = d.getFullYear();
      cursor.m = d.getMonth();
      ctx.refresh();
    };

    const monthbar = h('div.monthbar', [
      h('button.nav', { type: 'button', disabled: !canPrev, onclick: () => shift(-1) }, '‹'),
      title,
      h('div.tools', [
        h(
          'button.today',
          {
            type: 'button',
            onclick: () => {
              cursor.y = today.getFullYear();
              cursor.m = today.getMonth();
              ctx.refresh();
            },
          },
          '今天'
        ),
        h('button.nav', { type: 'button', onclick: () => shift(1) }, '›'),
      ]),
    ]);

    const weekhead = h('div.weekhead');
    WEEK_LABELS.forEach((label, i) => weekhead.append(h('span', { class: i >= 5 ? 'we' : '' }, label)));

    const grid = h('div.grid');
    const cells = monthMatrix(y, m);
    for (const date of cells) grid.append(dayCell(date, y, m, state, (key) => openDaySheet(key, ctx)));

    const swatch = (background, text) => h('div', [h('i', { style: { background } }), text]);
    const nameOf = (uid) => state.members[uid]?.name ?? uid;
    const legend = h('div.legend', [
      swatch('var(--work)', '两人都上班'),
      swatch('var(--u1-off)', `${nameOf('u1')} 放假`),
      swatch('var(--u2-off)', `${nameOf('u2')} 放假`),
      swatch('linear-gradient(135deg, var(--u1-off) 0 45%, var(--u2-off) 55% 100%)', '两人都放假'),
      swatch('linear-gradient(135deg, var(--work) 0 45%, var(--u2-off) 55% 100%)', '一人上班一人放假'),
    ]);

    const s = monthSummary(y, m, state);
    const stats = h('div.stats', [
      h('div', [h('b', { style: { color: 'var(--u1)' } }, String(s.u1)), h('span', `${nameOf('u1')} 休息`)]),
      h('div', [h('b', { style: { color: 'var(--u2)' } }, String(s.u2)), h('span', `${nameOf('u2')} 休息`)]),
      h('div', [
        h('b', { style: { background: 'var(--brand)', '-webkit-background-clip': 'text', color: 'transparent' } }, String(s.both)),
        h('span', '两人都休'),
      ]),
    ]);

    root.append(
      monthbar,
      h('div.calendar', [weekhead, grid]),
      annualCards(state, ctx),
      stats,
      legend
    );
  },
};
