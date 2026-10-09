/* 比较两份状态，用一句人话描述对方改了什么 */
import { LEAVE_TYPES } from './ops.js';
import { fmtDate } from './util.js';

const short = (text, max = 12) => (text && text.length > max ? `${text.slice(0, max)}…` : text ?? '');

export function describeChanges(prev, next) {
  if (!prev || !next || !prev.rev) return null;
  if (prev.rev === next.rev) return null;

  const out = [];
  const before = prev.leaves ?? {};
  const after = next.leaves ?? {};

  let added = 0;
  for (const [key, value] of Object.entries(after)) {
    const old = before[key];
    if (!old || old.type !== value.type) {
      added++;
      if (added <= 2) out.push(`把 ${fmtDate(value.date)} 记为${LEAVE_TYPES[value.type] ?? '假期'}`);
    }
  }
  let removed = 0;
  for (const key of Object.keys(before)) {
    if (!after[key]) {
      removed++;
      if (removed <= 1) out.push(`取消了 ${fmtDate(before[key].date)} 的假`);
    }
  }

  const tripsBefore = new Map((prev.trips ?? []).map((t) => [t.id, t]));
  const tripsAfter = new Map((next.trips ?? []).map((t) => [t.id, t]));
  for (const [id, trip] of tripsAfter) {
    const old = tripsBefore.get(id);
    if (!old) out.push(`新建了旅行「${short(trip.destination)}」`);
    else if (JSON.stringify(old) !== JSON.stringify(trip)) out.push(`更新了旅行「${short(trip.destination)}」`);
  }
  for (const [id, trip] of tripsBefore) {
    if (!tripsAfter.has(id)) out.push(`删除了旅行「${short(trip.destination)}」`);
  }

  const annivBefore = new Map((prev.anniversaries ?? []).map((a) => [a.id, a]));
  const annivAfter = new Map((next.anniversaries ?? []).map((a) => [a.id, a]));
  for (const [id, anniv] of annivAfter) {
    const old = annivBefore.get(id);
    if (!old) out.push(`加了纪念日「${short(anniv.title)}」`);
    else if (JSON.stringify(old) !== JSON.stringify(anniv)) out.push(`改了纪念日「${short(anniv.title)}」`);
  }
  for (const [id, anniv] of annivBefore) {
    if (!annivAfter.has(id)) out.push(`删除了纪念日「${short(anniv.title)}」`);
  }

  for (const uid of ['u1', 'u2']) {
    const a = prev.members?.[uid];
    const b = next.members?.[uid];
    if (a && b && (a.name !== b.name || a.region !== b.region || a.annualTotal !== b.annualTotal)) {
      if (a.name !== b.name) out.push(`把名字改成了「${short(b.name, 8)}」`);
      else if (a.region !== b.region) out.push('改了法定假期地区');
      else out.push('改了年假天数');
    }
  }

  if (!out.length) return null;
  return `${out.slice(0, 2).join('、')}${out.length > 2 ? ' 等' : ''}`;
}
