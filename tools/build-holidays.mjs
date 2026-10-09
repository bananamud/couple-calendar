/**
 * 把 data/raw 下的原始节假日数据（中国大陆 + 香港）合并成
 * public/data/holidays.json —— 具体逻辑在 src/holiday-data.js。
 *
 * 用法： node tools/build-holidays.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHolidays } from '../src/holiday-data.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = buildHolidays(root);

const count = (region) =>
  Object.entries(out.regions[region].years)
    .map(([y, v]) => `${y}:${Object.keys(v.days ?? {}).length}`)
    .join(' ');

console.log(`已写入 ${join(root, 'public', 'data', 'holidays.json')}`);
console.log(`  CN  ${count('CN')}`);
console.log(`  HK  ${count('HK')}`);
if (out.missingYears.length) console.log(`  尚无官方数据的年份：${out.missingYears.join(', ')}`);
