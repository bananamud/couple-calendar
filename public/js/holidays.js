/* 节假日数据（构建期生成，见 tools/build-holidays.mjs） */

let dataset = null;
let predictData = null;
let usePredict = false;

export async function loadHolidays() {
  if (!dataset) {
    dataset = await fetchData('holidays.json', { regions: { CN: { years: {} }, HK: { years: {} } }, missingYears: [] });
  }
  if (!predictData) {
    predictData = await fetchData('holidays-predict.json', null);
  }
  return dataset;
}

/**
 * 优先读接口（云端部署时数据存在数据库里，可能是最新抓取的），
 * 接口没有就退回打包进来的静态文件（本地 Node 版就是这种）。
 */
async function fetchData(file, fallback) {
  for (const url of [`./api/${file}`, `./data/${file}`]) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) return await res.json();
    } catch {
      /* 试下一个 */
    }
  }
  return fallback;
}

/** 是否使用「大陆假期预测版」（官方没公布的年份按惯例推算） */
export const setPredict = (on) => {
  usePredict = Boolean(on);
};
export const isPredictOn = () => usePredict;
export const predictRule = () => predictData?.rule ?? '';
export const predictNote = () => predictData?.note ?? '';
export const generatedAt = () => dataset?.generatedAt ?? null;

/** 重新拉取数据（更新完节假日之后调用） */
export async function reloadHolidays() {
  dataset = null;
  predictData = null;
  return loadHolidays();
}

/** 有哪些年份有预测数据 */
export function predictYears() {
  return Object.keys(predictData?.regions?.CN?.years ?? {}).sort();
}

export const REGION_LABEL = { CN: '中国大陆', HK: '香港' };

/** 返回该日期在指定地区的节假日信息：{ name, short, off, makeup } 或 null */
export function holidayOf(region, dateKey) {
  const year = dataset?.regions?.[region]?.years?.[String(dateKey).slice(0, 4)];
  const day = year?.days?.[dateKey];
  if (day) {
    return {
      name: day.name,
      short: day.short ?? shortHolidayName(day.name),
      off: day.off !== false,
      makeup: day.off === false,
      predicted: false,
    };
  }
  // 官方还没公布的年份：可选地使用预测版
  if (region === 'CN' && usePredict) {
    const p = predictData?.regions?.CN?.years?.[String(dateKey).slice(0, 4)]?.days?.[dateKey];
    if (p) {
      return {
        name: p.name,
        short: p.short ?? shortHolidayName(p.name),
        off: true,
        makeup: false,
        predicted: true,
      };
    }
  }
  return null;
}

export function knownYears(region) {
  return Object.keys(dataset?.regions?.[region]?.years ?? {})
    .filter((y) => Object.keys(dataset.regions[region].years[y].days ?? {}).length > 0)
    .sort();
}

export function sourceNote(region) {
  return dataset?.regions?.[region]?.source ?? '';
}

/** 兼容旧数据：把官方节假日名压缩成适合格子显示的两三个字 */
export function shortHolidayName(name) {
  if (!name) return '';
  const first = String(name).split('、')[0];
  return first.length > 2 ? first.replace(/(节|日)$/u, '') || first : first;
}
