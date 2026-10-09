/**
 * Node 版节假日数据构建：读 data/raw 下的原始数据 → 写 public/data/*.json。
 * 合并/预测的计算逻辑在 src/holiday-merge.js（纯函数，Worker 里也用同一套）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeHolidays, buildPredictions as buildPredictionsPure } from './holiday-merge.js';

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const writeJson = (file, data) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

/** 从 data/raw 里读出某前缀的所有年份文件 */
function readRawYears(rawDir, prefix) {
  if (!existsSync(rawDir)) return {};
  const out = {};
  for (const file of readdirSync(rawDir)) {
    if (!file.startsWith(`${prefix}-`) || !file.endsWith('.json')) continue;
    const year = file.slice(prefix.length + 1, -'.json'.length);
    if (!/^\d{4}$/.test(year)) continue;
    out[year] = readJson(join(rawDir, file));
  }
  return out;
}

/** 合并官方数据 → public/data/holidays.json */
export function buildHolidays(root) {
  const rawDir = join(root, 'data', 'raw');
  const cnRaw = readRawYears(rawDir, 'cn');
  const hkRaw = readRawYears(rawDir, 'hk');
  const out = mergeHolidays(cnRaw, hkRaw);
  writeJson(join(root, 'public', 'data', 'holidays.json'), out);
  // 云端 Worker 需要原始数据来重新合并，这里一并打包一份（只在部署时用）
  writeJson(join(root, 'public', 'data', 'holidays-source.json'), {
    generatedAt: new Date().toISOString(),
    cn: cnRaw,
    hk: { ...hkRaw, ...readRawYears(rawDir, 'hk-future') },
  });
  return out;
}

/** 大陆假期预测版 → public/data/holidays-predict.json */
export function buildPredictions(root) {
  const rawDir = join(root, 'data', 'raw');
  const hkRaw = { ...readRawYears(rawDir, 'hk'), ...readRawYears(rawDir, 'hk-future') };
  const official = readJson(join(root, 'public', 'data', 'holidays.json'));
  const officialCnYears = Object.entries(official?.regions?.CN?.years ?? {})
    .filter(([, v]) => Object.keys(v.days ?? {}).length > 0)
    .map(([y]) => y);

  const out = buildPredictionsPure(hkRaw, officialCnYears);
  writeJson(join(root, 'public', 'data', 'holidays-predict.json'), out);
  return out;
}
