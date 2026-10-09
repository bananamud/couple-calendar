/**
 * 纯逻辑：状态默认值 + 操作（op）应用。
 * 不依赖任何 Node / 浏览器专有 API，所以本地服务端和 Cloudflare Worker 共用同一份。
 */

export const LEAVE_TYPES = ['annual', 'personal', 'sick', 'comp', 'other'];

export function defaultState() {
  return {
    rev: 1,
    updatedAt: new Date().toISOString(),
    members: {
      u1: { name: '宝宝', region: 'CN', annualTotal: null },
      u2: { name: '宝贝', region: 'HK', annualTotal: null },
    },
    /** 键为 `${user}|${date}`，例如 u1|2026-10-05 */
    leaves: {},
    trips: [],
    anniversaries: [],
    /** 共享设置：cnPredict = 大陆假期是否使用「非官方预测版」 */
    settings: { cnPredict: false },
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

function cryptoId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function normalizeLeave(raw, fallbackUser, fallbackDate) {
  const user = raw?.user === 'u2' ? 'u2' : fallbackUser ?? 'u1';
  const date = DATE_RE.test(raw?.date) ? raw.date : fallbackDate;
  if (!date) return null;
  const type = LEAVE_TYPES.includes(raw?.type) ? raw.type : 'annual';
  return {
    user,
    date,
    type,
    note: str(raw?.note, 120),
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeTrip(raw, prev = null) {
  const base = prev ?? {};
  const id = str(raw?.id ?? base.id, 64) || cryptoId();
  const daysIn = Array.isArray(raw?.days) ? raw.days : base.days;
  const days = (daysIn ?? []).slice(0, 200).map((d) => ({
    id: str(d?.id, 64) || cryptoId(),
    title: str(d?.title, 60),
    note: str(d?.note, 4000),
  }));
  const budgetRaw = raw?.budget ?? base.budget;
  const budget = budgetRaw === '' || budgetRaw === null || budgetRaw === undefined ? null : Number(budgetRaw);
  return {
    id,
    destination: str(raw?.destination ?? base.destination, 60),
    startDate: DATE_RE.test(raw?.startDate ?? base.startDate) ? raw.startDate ?? base.startDate : null,
    budget: Number.isFinite(budget) ? budget : null,
    currency: str(raw?.currency ?? base.currency, 8) || 'CNY',
    note: str(raw?.note ?? base.note, 500),
    days: days.length ? days : [{ id: cryptoId(), title: '', note: '' }],
    createdAt: base.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: str(raw?.createdBy ?? base.createdBy, 4) || 'u1',
  };
}

export function normalizeAnniversary(raw, prev = null) {
  const base = prev ?? {};
  const rawOrder = raw?.order ?? base.order;
  return {
    id: str(raw?.id ?? base.id, 64) || cryptoId(),
    title: str(raw?.title ?? base.title, 60),
    date: DATE_RE.test(raw?.date ?? base.date) ? raw.date ?? base.date : '',
    emoji: str(raw?.emoji ?? base.emoji, 8) || '❤️',
    repeat: (raw?.repeat ?? base.repeat) === 'once' ? 'once' : 'yearly',
    note: str(raw?.note ?? base.note, 200),
    // 列表里的自定义顺序（排序模式拖动后保存）
    order: Number.isFinite(Number(rawOrder)) ? Number(rawOrder) : null,
    createdAt: base.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** 就地应用一批操作，返回 { applied, errors } */
export function applyOps(state, ops) {
  const errors = [];
  let applied = 0;

  for (const op of Array.isArray(ops) ? ops : []) {
    try {
      switch (op?.kind) {
        case 'leave.set': {
          const dates = (Array.isArray(op.dates) ? op.dates : [op.date]).filter((d) => DATE_RE.test(d));
          for (const date of dates) {
            const leave = normalizeLeave({ ...op, date }, op.user, date);
            if (!leave) continue;
            state.leaves[`${leave.user}|${leave.date}`] = leave;
          }
          applied++;
          break;
        }
        case 'leave.remove': {
          const dates = (Array.isArray(op.dates) ? op.dates : [op.date]).filter((d) => DATE_RE.test(d));
          for (const date of dates) delete state.leaves[`${op.user === 'u2' ? 'u2' : 'u1'}|${date}`];
          applied++;
          break;
        }
        case 'trip.create': {
          const trip = normalizeTrip(op.trip ?? op);
          if (!trip.destination) throw new Error('目的地不能为空');
          // 幂等：同一 id 重复提交不重复创建
          if (!state.trips.some((t) => t.id === trip.id)) state.trips.push(trip);
          applied++;
          break;
        }
        case 'trip.update': {
          const i = state.trips.findIndex((t) => t.id === op.id);
          if (i < 0) throw new Error('旅行计划不存在');
          if (op.patch?.deleted) state.trips.splice(i, 1);
          else state.trips[i] = normalizeTrip({ ...op.patch, id: op.id }, state.trips[i]);
          applied++;
          break;
        }
        case 'trip.delete': {
          const i = state.trips.findIndex((t) => t.id === op.id);
          if (i >= 0) state.trips.splice(i, 1);
          applied++;
          break;
        }
        case 'anniv.create': {
          const anniv = normalizeAnniversary(op.anniv ?? op);
          if (!anniv.title || !anniv.date) throw new Error('纪念日需要名称和日期');
          if (!state.anniversaries.some((a) => a.id === anniv.id)) {
            if (anniv.order === null) {
              const maxOrder = state.anniversaries.reduce((max, a) => Math.max(max, Number.isFinite(a.order) ? a.order : -1), -1);
              anniv.order = maxOrder + 1; // 新加的排最后
            }
            state.anniversaries.push(anniv);
          }
          applied++;
          break;
        }
        case 'anniv.reorder': {
          const ids = Array.isArray(op.ids) ? op.ids : [];
          let index = 0;
          const seen = new Set();
          for (const id of ids) {
            const item = state.anniversaries.find((a) => a.id === id);
            if (item && !seen.has(id)) {
              item.order = index++;
              item.updatedAt = new Date().toISOString();
              seen.add(id);
            }
          }
          for (const item of state.anniversaries) {
            if (!seen.has(item.id)) item.order = index++;
          }
          applied++;
          break;
        }
        case 'anniv.update': {
          const i = state.anniversaries.findIndex((a) => a.id === op.id);
          if (i < 0) throw new Error('纪念日不存在');
          if (op.patch?.deleted) state.anniversaries.splice(i, 1);
          else state.anniversaries[i] = normalizeAnniversary({ ...op.patch, id: op.id }, state.anniversaries[i]);
          applied++;
          break;
        }
        case 'anniv.delete': {
          const i = state.anniversaries.findIndex((a) => a.id === op.id);
          if (i >= 0) state.anniversaries.splice(i, 1);
          applied++;
          break;
        }
        case 'member.update': {
          const id = op.id === 'u2' ? 'u2' : 'u1';
          const prev = state.members[id] ?? { name: '', region: 'CN' };
          const rawTotal = op.patch?.annualTotal;
          let annualTotal = typeof prev.annualTotal === 'number' ? prev.annualTotal : null;
          if (rawTotal === null || rawTotal === '') annualTotal = null;
          else if (Number.isFinite(Number(rawTotal))) {
            annualTotal = Math.min(200, Math.max(0, Math.round(Number(rawTotal) * 2) / 2));
          }
          state.members[id] = {
            name: str(op.patch?.name ?? prev.name, 20) || prev.name,
            region: op.patch?.region === 'HK' ? 'HK' : op.patch?.region === 'CN' ? 'CN' : prev.region,
            annualTotal,
          };
          applied++;
          break;
        }
        case 'settings.update': {
          const prev = state.settings ?? { cnPredict: false };
          state.settings = {
            ...prev,
            cnPredict:
              typeof op.patch?.cnPredict === 'boolean' ? op.patch.cnPredict : Boolean(prev.cnPredict),
          };
          applied++;
          break;
        }
        default:
          throw new Error(`未知操作: ${op?.kind}`);
      }
    } catch (err) {
      errors.push(String(err.message ?? err));
    }
  }

  if (applied > 0) {
    state.rev += 1;
    state.updatedAt = new Date().toISOString();
  }
  return { applied, errors };
}
