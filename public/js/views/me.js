/* 设置页：用户身份、用户设置、节假日数据、分享链接、同步、手机 APP 安装方法 */
import { sync } from '../sync.js';
import { toast, field, segmented, copyText } from '../ui.js';
import { knownYears, sourceNote, predictYears, predictRule, generatedAt, reloadHolidays, REGION_LABEL } from '../holidays.js';
import { h, debounce } from '../util.js';

const STATUS_TEXT = {
  ok: '已同步',
  busy: '同步中…',
  connecting: '连接中…',
  off: '离线（改动会稍后补发）',
  locked: '需要配对链接',
};

/** 记住哪些模块是展开的：整页重绘后依然保持展开 */
const openSections = new Set();

/** 可折叠模块：默认收起，点标题展开 */
function collapsible(title, content, { open = false, hint = '' } = {}) {
  const isOpen = openSections.has(title) || open;
  const head = h('button.collapse-head', { type: 'button', 'aria-expanded': String(isOpen) }, [
    h('span.collapse-title', title),
    hint ? h('span.collapse-hint', hint) : null,
    h('span.collapse-arrow', '›'),
  ]);
  const body = h('div.collapse-body', h('div.collapse-inner', content));
  const wrap = h('section.collapse', [head, body]);
  if (isOpen) {
    wrap.classList.add('open');
    head.setAttribute('aria-expanded', 'true');
  }
  head.addEventListener('click', () => {
    const nowOpen = wrap.classList.toggle('open');
    head.setAttribute('aria-expanded', String(nowOpen));
    if (nowOpen) openSections.add(title);
    else openSections.delete(title);
  });
  return wrap;
}

export const MeView = {
  topbar: () => ({ title: '⚙️ 设置' }),

  render(root, _params, ctx) {
    const state = sync.state;

    /* 用户：这台手机是谁 */
    const whoSeg = h('div.seg');
    for (const uid of ['u1', 'u2']) {
      const btn = h(
        'button',
        { type: 'button', dataset: { active: String(sync.me === uid) } },
        `${state.members[uid]?.name ?? uid}${sync.me === uid ? '（我）' : ''}`
      );
      btn.addEventListener('click', () => {
        sync.setMe(uid);
        ctx.refresh();
      });
      whoSeg.append(btn);
    }
    root.append(
      h('div.card', [
        h('div', { style: { fontSize: '13px', fontWeight: '700', color: 'var(--ink-2)', marginBottom: '8px' } }, '用户'),
        whoSeg,
        h('div.hint', '选好之后，日历上的「我」就是这个人；两台手机各选一次即可。'),
      ])
    );

    /* 用户设置：名字 + 法定假期地区 */
    const memberCards = [];
    for (const uid of ['u1', 'u2']) {
      const member = state.members[uid] ?? {};
      const nameInput = h('input', { type: 'text', value: member.name ?? '', maxlength: '20' });
      const saveName = debounce(() => {
        const name = nameInput.value.trim();
        if (name) sync.dispatch({ kind: 'member.update', id: uid, patch: { name } });
      }, 600);
      nameInput.addEventListener('input', saveName);
      nameInput.addEventListener('blur', () => {
        if (!nameInput.value.trim()) {
          nameInput.value = member.name ?? '';
          toast('名字不能为空');
        }
      });

      const regionSeg = segmented(
        [
          { value: 'CN', label: '中国大陆' },
          { value: 'HK', label: '香港' },
        ],
        member.region ?? 'CN',
        (region) => {
          sync.dispatch({ kind: 'member.update', id: uid, patch: { region } });
          toast(`已切换为${REGION_LABEL[region]}假期`);
          ctx.refresh();
        }
      );

      memberCards.push(
        h('div.card', { style: { marginBottom: '12px' } }, [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } }, [
            h('span', {
              style: {
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                background: `var(--${uid})`,
                display: 'inline-block',
              },
            }),
            h('b', uid === 'u1' ? '蓝色' : '粉色'),
          ]),
          field('名字', nameInput),
          h('div.field', [
            h('label', '法定假期地区'),
            regionSeg,
            h('div.hint', '中国大陆用淡蓝标注，香港用淡粉标注，两人都放假时显示渐变。'),
          ]),
        ])
      );
    }
    root.append(h('div.section-title', '用户设置'), ...memberCards);

    /* 节假日数据（可折叠） */
    const cnYears = knownYears('CN');
    const hkYears = knownYears('HK');
    const predicted = predictYears();
    const missing = predicted.filter((y) => !cnYears.includes(y));
    const predictOn = state.settings?.cnPredict === true;
    const predictSeg = segmented(
      [
        { value: 'official', label: '官方公告' },
        { value: 'predict', label: '预测版' },
      ],
      predictOn ? 'predict' : 'official',
      (value) => {
        sync.dispatch({ kind: 'settings.update', patch: { cnPredict: value === 'predict' } });
        toast(value === 'predict' ? '已按惯例预测大陆放假安排' : '已切回官方公告');
        ctx.refresh();
      }
    );

    const updatedLabel = h('div.hint');
    const syncUpdatedLabel = () => {
      const at = generatedAt();
      updatedLabel.textContent = at ? `数据更新于 ${new Date(at).toLocaleString('zh-CN')}` : '数据更新时间未知';
    };
    syncUpdatedLabel();

    const checkBtn = h('button.ghost-btn', { type: 'button' }, '检查更新');
    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = '检查中…';
      try {
        const res = await fetch(sync.api('./api/holidays/update'), { method: 'POST' });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error ?? '更新失败');
        await reloadHolidays();
        syncUpdatedLabel();
        toast(data.changed?.length ? `已更新：${data.changed.join('、')}` : '已是最新，官方还没公布新数据');
        // 只有真的更新到了新数据才重绘（否则刚展开的模块会被收起）
        if (data.changed?.length) ctx.refresh();
      } catch (err) {
        toast(`检查失败：${err.message}`);
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = '检查更新';
      }
    });

    root.append(
      collapsible(
        '节假日数据',
        [
          h('div.field', [
            h('label', '大陆放假安排（官方未公布的年份）'),
            predictSeg,
            h('div.hint', [
              predictOn
                ? `正在使用预测版。规则：${predictRule()}预测出来的日期在日历上会带虚线边框。`
                : `官方还没公布的年份（${missing.join('、') || '暂无'}）只按工作日/周末上色；打开预测版可以按惯例先排出来。`,
              h('br'),
              '预测版是按近年放假惯例推算的，不是官方安排，节假日办正事前请再核对一下。',
            ]),
          ]),
          h('div.list-item', { style: { padding: '4px 0' } }, [
            h('div.emoji', '🇨🇳'),
            h('div.grow', [
              h('div.t', '中国大陆法定节假日'),
              h('div.s', `${cnYears.join('、') || '暂无'} · 含调休上班日${predictOn && predicted.length ? ` · 预测 ${predicted.join('、')}` : ''}`),
            ]),
          ]),
          h('div.list-item', { style: { padding: '4px 0' } }, [
            h('div.emoji', '🇭🇰'),
            h('div.grow', [h('div.t', '香港法定节假日'), h('div.s', hkYears.join('、') || '暂无')]),
          ]),
          h('div.row-btns', [checkBtn]),
          h('div', { style: { marginTop: '8px' } }, updatedLabel),
          h('div.hint', '服务端每天会自动检查一次；官方公布新一年安排后，这里点一下就能立刻更新。'),
          h('div.hint', [
            `大陆：${sourceNote('CN')}`,
            h('br'),
            `香港：${sourceNote('HK')}`,
            missing.length ? h('br') : null,
            missing.length ? `${missing.join('、')} 年大陆放假安排官方尚未公布，公布后重新运行 node tools/build-holidays.mjs 即可补充。` : null,
          ]),
        ],
        { hint: predictOn ? '预测版' : '官方公告' }
      )
    );

    /* 分享链接（可折叠） */
    const shareCard = h('div', [h('div.hint', '正在检查分享状态…')]);
    (async () => {
      let info = null;
      try {
        const res = await fetch(sync.api('./api/share'), { cache: 'no-store' });
        if (res.ok) info = await res.json();
      } catch {
        /* 离线时静默 */
      }
      shareCard.innerHTML = '';
      if (info?.enabled && (info.publicUrl || info.token)) {
        const base = (info.publicUrl || info.origin || location.origin).replace(/\/$/, '');
        const link = `${base}/?k=${encodeURIComponent(info.token)}`;
        const isCloud = info.mode === 'cloud';
        const copyBtn = h('button.ghost-btn', { type: 'button' }, '复制配对链接');
        copyBtn.addEventListener('click', async () => {
          const ok = await copyText(link);
          toast(ok ? '已复制，发给对方就行' : '复制失败，长按上面的链接手动复制');
        });
        shareCard.append(
          h('div.list-item', { style: { padding: '0 0 4px', borderBottom: 'none' } }, [
            h('div.emoji', '🌍'),
            h('div.grow', [
              h('div.t', isCloud ? '云端服务已开启' : '分享链接可用'),
              h(
                'div.s',
                isCloud
                  ? `${new URL(base).host} · 电脑关机也能用`
                  : `${new URL(base).host} · 更新于 ${info.updatedAt ? new Date(info.updatedAt).toLocaleTimeString('zh-CN') : '刚刚'}`
              ),
            ]),
          ]),
          h('div.link-box', link),
          h('div.row-btns', [copyBtn]),
          h('div.hint', [
            '把这个链接发给对方，手机浏览器打开即可（链接里的密钥就是门锁，别发到公开群里）。',
            h('br'),
            '对方打开后建议「添加到主屏幕 / 安装应用」，以后点图标就能用。',
          ])
        );
      } else {
        shareCard.append(
          h('div.list-item', { style: { padding: '0 0 4px', borderBottom: 'none' } }, [
            h('div.emoji', '🌍'),
            h('div.grow', [
              h('div.t', '还没开启分享'),
              h('div.s', info?.publicUrl ? '上次的地址已失效（电脑上的分享窗口关掉了）' : '开启后，不在同一个 Wi-Fi 也能同步'),
            ]),
          ]),
          h('div.hint', [
            '在电脑上双击项目里的「启动并分享给外网.bat」，会生成一个带密钥的公网链接；',
            '把链接发给对方，两边就都能随时同步了。',
            h('br'),
            '代价是电脑要保持开机（和这个分享窗口不能关）。想让电脑关机也能用，看 README 的云端部署方案。',
          ])
        );
      }
    })();
    root.append(collapsible('分享链接', shareCard));

    /* 同步（可折叠） */
    const syncBtn = h('button.ghost-btn', { type: 'button' }, '立即同步');
    syncBtn.addEventListener('click', async () => {
      try {
        await sync.fetchState();
        await sync.flush();
        toast('已是最新');
        ctx.refresh();
      } catch {
        toast('连不上服务端，检查电脑那边是否还开着');
      }
    });
    root.append(
      collapsible(
        '同步',
        [
          h('div.list-item', { style: { padding: '4px 0 12px' } }, [
            h('div.emoji', sync.status === 'ok' ? '🟢' : sync.status === 'off' ? '⚪️' : '🟡'),
            h('div.grow', [
              h('div.t', STATUS_TEXT[sync.status] ?? sync.status),
              h('div.s', [
                sync.pending.length ? `${sync.pending.length} 项改动等待发送 · ` : '',
                sync.lastSyncAt ? `最近同步 ${new Date(sync.lastSyncAt).toLocaleTimeString('zh-CN')}` : '尚未同步',
              ]),
            ]),
          ]),
          syncBtn,
          h('div.hint', [
            `服务地址：${location.origin}`,
            h('br'),
            '两台手机连同一个 Wi-Fi，用这个地址访问就能看到同一份数据；改动会自动互相同步。',
          ]),
        ],
        { hint: STATUS_TEXT[sync.status] ?? '' }
      )
    );

    /* 手机 APP 安装方法（可折叠） */
    root.append(
      collapsible(
        '手机 APP 安装方法',
        [
          h('div.list-item', { style: { padding: '4px 0' } }, [
            h('div.emoji', '🍎'),
            h('div.grow', [h('div.t', 'iPhone'), h('div.s', 'Safari 打开 → 分享 → 添加到主屏幕')]),
          ]),
          h('div.list-item', { style: { padding: '4px 0' } }, [
            h('div.emoji', '🤖'),
            h('div.grow', [h('div.t', 'Android'), h('div.s', 'Chrome 打开 → 右上角菜单 → 安装应用')]),
          ]),
          h('div.hint', '添加后就是全屏 App 的样子，和普通 App 一样用；断网也能打开。'),
        ],
        { hint: 'iPhone / Android' }
      )
    );

    /* 数据备份（可折叠） */
    const exportBtn = h('button.ghost-btn', { type: 'button' }, '导出备份 JSON');
    exportBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(sync.state, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `情侣日历备份-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      toast('已导出到下载目录');
    });
    root.append(
      collapsible(
        '数据备份',
        [
          exportBtn,
          h('div.hint', ['数据存放在电脑上的 data/store.json，删除它等于清空所有记录。']),
        ],
        { hint: '导出 JSON' }
      )
    );
  },
};
