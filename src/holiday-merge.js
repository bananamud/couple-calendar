/**
 * 节假日数据的「纯计算」部分：不碰文件系统，Node 和 Cloudflare Worker 都能用。
 *   mergeHolidays()      原始数据 → 前端用的节假日结构
 *   buildPredictions()    香港节日日期 → 大陆假期预测版
 */

const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};
const addDays = (date, n) => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
};

/* ----------------------------- 繁转简 & 短名 ----------------------------- */

const T2S = {
  農: '农', 曆: '历', 穌: '稣', 難: '难', 節: '节', 復: '复', 誕: '诞', 勞: '劳', 動: '动',
  陽: '阳', 聖: '圣', 別: '别', 區: '区', 紀: '纪', 華: '华', 國: '国', 慶: '庆', 週: '周',
  東: '东', 門: '门', 觀: '观', 禮: '礼', 龍: '龙', 馬: '马', 鳥: '鸟', 蘭: '兰', 醫: '医',
  師: '师', 學: '学', 樂: '乐', 豐: '丰', 內: '内', 兩: '两', 開: '开', 關: '关', 無: '无',
  為: '为', 與: '与', 臺: '台', 灣: '湾', 陸: '陆', 際: '际', 員: '员', 業: '业', 產: '产',
  務: '务', 場: '场', 車: '车', 進: '进', 遠: '远', 選: '选', 舉: '举', 錢: '钱', 長: '长',
};

export const toSimplified = (text) =>
  String(text ?? '')
    .split('')
    .map((ch) => T2S[ch] ?? ch)
    .join('');

const HK_SHORT = {
  元旦新年: '元旦',
  農曆年初一: '初一',
  農曆年初二: '初二',
  農曆年初三: '初三',
  清明節: '清明',
  耶穌受難節: '受难节',
  耶穌受難節翌日: '圣周六',
  復活節星期一: '复活节',
  勞動節: '劳动',
  佛誕: '佛诞',
  端午節: '端午',
  香港特別行政區成立紀念日: '回归日',
  中華人民共和國國慶日: '国庆',
  中秋節: '中秋',
  中秋節翌日: '中秋',
  重陽節: '重阳',
  聖誕節: '圣诞',
  聖誕節翌日: '节礼日',
  聖誕節後第一個周日: '节礼日',
};

/** 个别假期用香港政府的正式叫法，避免看日历的人不认识 */
const HK_NAME = {
  聖誕節翌日: '圣诞节后第一个周日',
  聖誕節後第一個周日: '圣诞节后第一个周日',
};

/** 大陆假期名：去掉结尾的「节/日」，但两个字的名字（春节、元旦）保持原样 */
export function cnShort(name) {
  const first = String(name ?? '').split('、')[0];
  return first.length > 2 ? first.replace(/(节|日)$/u, '') || first : first;
}

/* ------------------------------- 合并官方数据 ------------------------------- */

/**
 * @param {{[year:string]: {papers?:string[], days?:Array<{name:string,date:string,isOffDay:boolean}>}}} cnRaw
 * @param {{[year:string]: Array<{date:string, localName?:string, name?:string}>}} hkRaw
 */
export function mergeHolidays(cnRaw, hkRaw) {
  const regions = {
    CN: { id: 'CN', label: '中国大陆', source: '国务院办公厅放假通知（via holiday-cn）', years: {} },
    HK: { id: 'HK', label: '香港', source: '香港政府宪报公众假期（via nager.at）', years: {} },
  };
  const missing = [];

  for (const year of Object.keys(cnRaw ?? {}).sort()) {
    const data = cnRaw[year];
    const days = {};
    for (const d of data?.days ?? []) {
      if (!d?.date) continue;
      const item = { name: d.name, short: cnShort(d.name), off: d.isOffDay !== false };
      if (d.isOffDay === false) item.makeup = true;
      days[d.date] = item;
    }
    if (Object.keys(days).length === 0) missing.push(`CN ${year}`);
    regions.CN.years[year] = { papers: data?.papers ?? [], days };
  }

  for (const year of Object.keys(hkRaw ?? {}).sort()) {
    const list = hkRaw[year];
    const days = {};
    for (const d of Array.isArray(list) ? list : []) {
      if (!d?.date) continue;
      const rawName = d.localName || d.name || '';
      days[d.date] = {
        name: HK_NAME[rawName] ?? toSimplified(rawName),
        short: HK_SHORT[rawName] ?? toSimplified(rawName).slice(0, 3),
        off: true,
      };
    }
    if (Object.keys(days).length === 0) missing.push(`HK ${year}`);
    regions.HK.years[year] = { papers: [], days };
  }

  return {
    generatedAt: new Date().toISOString(),
    note: '自动生成，请勿手工编辑；重新生成请运行 node tools/build-holidays.mjs',
    missingYears: missing,
    regions,
  };
}

/* ------------------------------- 预测版 ------------------------------- */

/** 21 世纪清明日期公式（只算 4 月的哪一天） */
function qingmingDay(year) {
  const y = year % 100;
  return Math.floor(y * 0.2422 + 4.81) - Math.floor(y / 4);
}

/** 从香港数据里取农历节日日期（香港会提前公布） */
function hkLunar(hkRaw, year) {
  const list = hkRaw?.[String(year)];
  if (!Array.isArray(list)) return null;
  const find = (re) => list.find((d) => re.test(d.localName || d.name || ''));
  const cny1 = find(/年初一/);
  const dragon = find(/端午/);
  const midAutumnNext = find(/中秋/);
  if (!cny1 || !dragon || !midAutumnNext) return null;
  return {
    cnyFirst: cny1.date,
    dragonBoat: dragon.date,
    midAutumn: key(addDays(parse(midAutumnNext.date), -1)),
  };
}

/**
 * @param {{[year:string]: Array}} hkRaw 香港官方数据（含未来年份）
 * @param {string[]} officialCnYears 已经有大陆官方数据的年份
 */
export function buildPredictions(hkRaw, officialCnYears = []) {
  const official = new Set(officialCnYears.map(String));
  const years = Object.keys(hkRaw ?? {})
    .filter((y) => /^\d{4}$/.test(y))
    .sort()
    .filter((y) => Number(y) >= 2025 && !official.has(y));

  const result = {
    generatedAt: new Date().toISOString(),
    note: '非官方预测，按近年放假惯例推算，仅供提前规划参考；实际安排以国务院办公厅通知为准。',
    rule: '春节按除夕起 8 天，国庆 10/1 起 7 天，劳动节 5/1 起 5 天，其余按节日当日；不含调休上班日。',
    regions: { CN: { label: '中国大陆（预测）', years: {} } },
  };

  for (const year of years) {
    const lunar = hkLunar(hkRaw, year);
    if (!lunar) continue;
    const days = {};
    const put = (date, name, short) => {
      const k = typeof date === 'string' ? date : key(date);
      days[k] = { name, short, off: true, predicted: true };
    };
    const span = (startKey, count, name, short) => {
      const start = parse(startKey);
      for (let i = 0; i < count; i++) put(addDays(start, i), name, short);
    };

    put(`${year}-01-01`, '元旦', '元旦');
    span(key(addDays(parse(lunar.cnyFirst), -1)), 8, '春节', '春节');
    put(`${year}-04-${pad(qingmingDay(Number(year)))}`, '清明节', '清明');
    span(`${year}-05-01`, 5, '劳动节', '劳动');
    put(lunar.dragonBoat, '端午节', '端午');

    const nationalStart = `${year}-10-01`;
    const nationalEnd = key(addDays(parse(nationalStart), 6));
    span(nationalStart, 7, '国庆节', '国庆');
    if (lunar.midAutumn < nationalStart || lunar.midAutumn > nationalEnd) {
      put(lunar.midAutumn, '中秋节', '中秋');
    }
    result.regions.CN.years[year] = { predicted: true, days };
  }

  return result;
}
