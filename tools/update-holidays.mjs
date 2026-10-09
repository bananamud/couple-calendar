/**
 * 自动更新节假日数据（命令行入口，逻辑在 src/update-holidays.js）。
 *
 * 数据来源：
 *   · 中国大陆：国务院办公厅放假通知（holiday-cn 仓库）
 *   · 香港：香港政府宪报公众假期（nager.at）
 *
 * 用法：
 *   node tools/update-holidays.mjs               # 更新今年/明年缺的年份
 *   node tools/update-holidays.mjs --years 2027  # 指定年份
 *   node tools/update-holidays.mjs --json        # 输出机器可读结果
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateHolidays, STATUS_TEXT } from '../src/update-holidays.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');

const years = (() => {
  const i = args.indexOf('--years');
  if (i < 0) return null;
  const list = args
    .slice(i + 1)
    .filter((a) => /^\d{4}$/.test(a))
    .map(Number);
  return list.length ? list : null;
})();

const summary = await updateHolidays(root, {
  years,
  log: asJson ? () => {} : (msg) => console.log(`  ${msg}`),
});

if (asJson) {
  console.log(JSON.stringify(summary));
} else {
  for (const r of summary.results) {
    console.log(`  ${r.region} ${r.year}：${STATUS_TEXT[r.status] ?? r.status}${r.days ? `（${r.days} 条）` : ''}`);
  }
  console.log(
    summary.changed.length
      ? `\n  完成：更新了 ${summary.changed.join('、')}，前端数据已重新生成。`
      : '\n  没有需要更新的年份，数据已是最新。'
  );
}
