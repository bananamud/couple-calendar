/**
 * 客户端（乐观更新 / 离线）使用的操作应用逻辑，行为与服务端 src/store.js 保持一致。
 * 服务端返回的状态始终是权威结果，这里只是为了让界面立刻响应。
 */
import { uid } from './util.js';

export const LEAVE_TYPES = {
  annual: '年假',
  personal: '事假',
  sick: '病假',
  comp: '调休',
  other: '其他',
};

const clone = (v) => (globalThis.structuredClone ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
const nowIso = () => new Date().toISOString();
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

export function applyOps(state, ops) {
  const next = clone(state);
  let applied = 0;

  for (const op of Array.isArray(ops) ? ops : []) {
    const dates = (Array.isArray(op.dates) ? op.dates : op.date ? [op.date] : []).filter(Boolean);
    switch (op.kind) {
      case 'leave.set': {
        const user = op.user === 'u2' ? 'u2' : 'u1';
        for (const date of dates) {
          next.leaves[`${user}|${date}`] = {
            user,
            date,
            type: LEAVE_TYPES[op.type] ? op.type : 'annual',
            note: op.note ?? '',
            updatedAt: nowIso(),
          };
        }
        applied++;
        break;
      }
      case 'leave.remove': {
        const user = op.user === 'u2' ? 'u2' : 'u1';
        for (const date of dates) delete next.leaves[`${user}|${date}`];
        applied++;
        break;
      }
      case 'trip.create': {
        const t = op.trip ?? op;
        if (next.trips.some((x) => x.id === t.id)) {
          applied++;
          break;
        }
        next.trips.push({
          id: t.id ?? uid(),
          destination: t.destination ?? '',
          startDate: t.startDate ?? null,
          budget: num(t.budget),
          currency: t.currency ?? 'CNY',
          note: t.note ?? '',
          days: (t.days ?? []).map((d) => ({ id: d.id ?? uid(), title: d.title ?? '', note: d.note ?? '' })),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          createdBy: t.createdBy ?? 'u1',
        });
        applied++;
        break;
      }
      case 'trip.update': {
        const i = next.trips.findIndex((t) => t.id === op.id);
        if (i >= 0) {
          if (op.patch?.deleted) next.trips.splice(i, 1);
          else next.trips[i] = { ...next.trips[i], ...op.patch, budget: num(op.patch?.budget ?? next.trips[i].budget), updatedAt: nowIso() };
        }
        applied++;
        break;
      }
      case 'trip.delete': {
        const i = next.trips.findIndex((t) => t.id === op.id);
        if (i >= 0) next.trips.splice(i, 1);
        applied++;
        break;
      }
      case 'anniv.create': {
        const a = op.anniv ?? op;
        if (next.anniversaries.some((x) => x.id === a.id)) {
          applied++;
          break;
        }
        next.anniversaries.push({
          id: a.id ?? uid(),
          title: a.title ?? '',
          date: a.date ?? '',
          emoji: a.emoji || '❤️',
          repeat: a.repeat === 'once' ? 'once' : 'yearly',
          note: a.note ?? '',
          order: Number.isFinite(Number(a.order))
            ? Number(a.order)
            : next.anniversaries.reduce((m, x) => Math.max(m, Number.isFinite(x.order) ? x.order : -1), -1) + 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        applied++;
        break;
      }
      case 'anniv.reorder': {
        const ids = Array.isArray(op.ids) ? op.ids : [];
        let index = 0;
        const seen = new Set();
        for (const id of ids) {
          const item = next.anniversaries.find((a) => a.id === id);
          if (item && !seen.has(id)) {
            item.order = index++;
            seen.add(id);
          }
        }
        for (const item of next.anniversaries) if (!seen.has(item.id)) item.order = index++;
        applied++;
        break;
      }
      case 'anniv.update': {
        const i = next.anniversaries.findIndex((a) => a.id === op.id);
        if (i >= 0) {
          if (op.patch?.deleted) next.anniversaries.splice(i, 1);
          else next.anniversaries[i] = { ...next.anniversaries[i], ...op.patch, updatedAt: nowIso() };
        }
        applied++;
        break;
      }
      case 'anniv.delete': {
        const i = next.anniversaries.findIndex((a) => a.id === op.id);
        if (i >= 0) next.anniversaries.splice(i, 1);
        applied++;
        break;
      }
      case 'member.update': {
        const id = op.id === 'u2' ? 'u2' : 'u1';
        next.members[id] = { ...next.members[id], ...op.patch };
        applied++;
        break;
      }
      case 'settings.update': {
        next.settings = { ...(next.settings ?? {}), ...op.patch };
        applied++;
        break;
      }
      default:
        break;
    }
  }

  if (applied > 0) {
    next.rev = (next.rev ?? 0) + 1;
    next.updatedAt = nowIso();
  }
  return next;
}
