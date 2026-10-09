/**
 * 节假日数据自动更新（同一进程内完成，不依赖子进程）：
 *   1. 缺哪一年就抓哪一年（大陆 holiday-cn、香港 nager.at，都带镜像重试）
 *   2. 重新生成 public/data/holidays.json 和 holidays-predict.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildHolidays, buildPredictions } from './holiday-data.js';

/** 带超时的信号：定时器 unref，不会拖住进程 */
function timeoutSignal(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  timer.unref?.();
  return ctrl.signal;
}

/**
 * 依次尝试多个地址。
 * 返回 { ok, status, data }，status=404 表示官方还没放出这一年的文件。
 */
async function fetchJson(urls, timeout = 20000) {
  let lastStatus = 0;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: timeoutSignal(timeout),
        headers: { 'user-agent': 'couple-calendar-updater' },
        redirect: 'follow',
      });
      if (res.status === 404) {
        lastStatus = 404;
        continue;
      }
      if (!res.ok) {
        lastStatus = res.status;
        continue;
      }
      return { ok: true, status: res.status, data: JSON.parse(await res.text()) };
    } catch {
      lastStatus = -1;
    }
  }
  return { ok: false, status: lastStatus, data: null };
}

const readJsonFile = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const cnDayCount = (data) => (Array.isArray(data?.days) ? data.days.length : 0);

/** 已经收录了官方数据的年份 */
export function officialYears(root, region) {
  const data = readJsonFile(join(root, 'public', 'data', 'holidays.json'));
  const years = data?.regions?.[region]?.years ?? {};
  return Object.entries(years)
    .filter(([, v]) => Object.keys(v.days ?? {}).length > 0)
    .map(([y]) => Number(y));
}

/** 今年、明年里还缺官方数据的年份 */
export function missingYears(root) {
  const cn = officialYears(root, 'CN');
  const hk = officialYears(root, 'HK');
  const thisYear = new Date().getFullYear();
  return [thisYear, thisYear + 1].filter((y) => y >= 2025 && (!cn.includes(y) || !hk.includes(y)));
}

async function updateCn(root, year) {
  const rawDir = join(root, 'data', 'raw');
  const file = join(rawDir, `cn-${year}.json`);
  const res = await fetchJson([
    `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
    `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
  ]);
  if (!res.ok) {
    return { region: 'CN', year, status: res.status === 404 ? 'not-published' : 'fetch-failed' };
  }
  const count = cnDayCount(res.data);
  const oldCount = cnDayCount(readJsonFile(file));
  if (count === 0) return { region: 'CN', year, status: oldCount > 0 ? 'kept' : 'not-published' };
  writeFileSync(file, `${JSON.stringify(res.data, null, 2)}\n`, 'utf8');
  return { region: 'CN', year, status: oldCount === count ? 'up-to-date' : 'updated', days: count };
}

async function updateHk(root, year) {
  const rawDir = join(root, 'data', 'raw');
  const file = join(rawDir, `hk-${year}.json`);
  const res = await fetchJson([`https://date.nager.at/api/v3/PublicHolidays/${year}/HK`]);
  const data = res.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { region: 'HK', year, status: res.status === 404 ? 'not-published' : 'fetch-failed' };
  }
  const old = readJsonFile(file);
  const oldCount = Array.isArray(old) ? old.length : 0;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { region: 'HK', year, status: oldCount === data.length ? 'up-to-date' : 'updated', days: data.length };
}

export const STATUS_TEXT = {
  updated: '已更新',
  'up-to-date': '已是最新',
  'already-have': '已有官方数据',
  'not-published': '官方尚未公布',
  kept: '官方文件为空，保留原数据',
  'fetch-failed': '拉取失败（网络问题？）',
};

/**
 * 执行一次更新。
 * @returns {{checkedAt:string, years:number[], results:object[], changed:string[], rebuilt:boolean, generatedAt:string|null}}
 */
export async function updateHolidays(root, { years, log = () => {} } = {}) {
  if (!existsSync(join(root, 'data', 'raw'))) mkdirSync(join(root, 'data', 'raw'), { recursive: true });
  const targets = years?.length ? years : missingYears(root);

  const cnOfficial = new Set(officialYears(root, 'CN'));
  const hkOfficial = new Set(officialYears(root, 'HK'));
  const results = [];

  for (const year of targets) {
    if (!cnOfficial.has(year)) results.push(await updateCn(root, year));
    else results.push({ region: 'CN', year, status: 'already-have' });
    if (!hkOfficial.has(year)) results.push(await updateHk(root, year));
    else results.push({ region: 'HK', year, status: 'already-have' });
  }

  const changed = results.filter((r) => r.status === 'updated');
  let rebuilt = false;
  if (changed.length) {
    log(`更新了 ${changed.map((r) => `${r.region} ${r.year}`).join('、')}，正在重新生成数据…`);
    buildHolidays(root);
    buildPredictions(root);
    rebuilt = true;
  }

  return {
    checkedAt: new Date().toISOString(),
    years: targets,
    results,
    changed: changed.map((r) => `${r.region} ${r.year}`),
    rebuilt,
    generatedAt: readJsonFile(join(root, 'public', 'data', 'holidays.json'))?.generatedAt ?? null,
  };
}
