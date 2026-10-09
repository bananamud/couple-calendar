/**
 * 生成「大陆假期预测版」public/data/holidays-predict.json
 * —— 具体逻辑在 src/holiday-data.js。
 *
 * 用法： node tools/build-predictions.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPredictions } from '../src/holiday-data.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = buildPredictions(root);

console.log(`已写入 ${join(root, 'public', 'data', 'holidays-predict.json')}`);
for (const [year, data] of Object.entries(out.regions.CN.years)) {
  const list = Object.entries(data.days)
    .sort()
    .map(([k, v]) => `${k.slice(5)} ${v.name}`)
    .join('、');
  console.log(`  ${year}: ${Object.keys(data.days).length} 天 —— ${list}`);
}
