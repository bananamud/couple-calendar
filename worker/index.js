/**
 * Cloudflare Workers 版后端（云端部署用）。
 *
 * 与本地 Node 版功能一致：读写状态、应用操作、访问密钥、节假日数据，
 * 差别有两个：
 *   · 数据存在 D1（SQLite），不依赖服务器本机磁盘
 *   · 没有常驻进程，所以不做 SSE 实时推送，改成前端定时拉取（/api/meta 会告诉前端）
 *
 * 部署：见 README 的「部署到云端」。
 */
import { applyOps, defaultState } from '../src/ops-core.js';
import { mergeHolidays, buildPredictions } from '../src/holiday-merge.js';

const API_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: API_HEADERS });

/* ------------------------------- 访问密钥 ------------------------------- */

/** 简单的定长比较，避免用时间差猜密钥 */
function keyMatches(expected, provided) {
  if (!expected || typeof provided !== 'string') return false;
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

function authorized(request, url, env) {
  const expected = String(env.ACCESS_KEY ?? '').trim();
  if (!expected) return true; // 没配密钥＝公开（只适合自己先用着试试）
  const provided = url.searchParams.get('k') ?? request.headers.get('x-cc-key') ?? '';
  return keyMatches(expected, provided);
}

/* -------------------------------- 存储 -------------------------------- */

async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS raw_data (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS holidays (id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)'),
  ]);
}

async function loadState(env) {
  const row = await env.DB.prepare('SELECT data FROM state WHERE id = 1').first();
  if (!row?.data) return defaultState();
  try {
    return JSON.parse(row.data);
  } catch {
    return defaultState();
  }
}

async function saveState(env, state) {
  await env.DB.prepare(
    'INSERT INTO state (id, data, updated_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2'
  )
    .bind(JSON.stringify(state), new Date().toISOString())
    .run();
}

const nowIso = () => new Date().toISOString();

async function readRawAll(env) {
  const { results } = await env.DB.prepare('SELECT key, data FROM raw_data').all();
  const cn = {};
  const hk = {};
  for (const row of results ?? []) {
    try {
      const value = JSON.parse(row.data);
      if (row.key.startsWith('cn-')) cn[row.key.slice(3)] = value;
      else if (row.key.startsWith('hk-')) hk[row.key.slice(3)] = value;
    } catch {
      /* 忽略坏数据 */
    }
  }
  return { cn, hk };
}

async function putRaw(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO raw_data (key, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET data = ?2, updated_at = ?3'
  )
    .bind(key, JSON.stringify(value), nowIso())
    .run();
}

/** 首次运行时，用打包进来的原始数据把 D1 填好 */
async function seedRawFromAssets(env, origin) {
  const { cn, hk } = await readRawAll(env);
  if (Object.keys(cn).length || Object.keys(hk).length) return false;
  // 用固定的内部地址取静态资源：assets 绑定按路径匹配，不依赖真实域名，
  // 这样定时任务里也能拿到打包进来的原始数据
  const res = await env.ASSETS.fetch(new Request('https://assets.internal/data/holidays-source.json'));
  if (!res.ok) return false;
  const source = await res.json();
  const statements = [];
  for (const [year, data] of Object.entries(source.cn ?? {})) {
    statements.push(env.DB.prepare('INSERT OR REPLACE INTO raw_data (key, data, updated_at) VALUES (?1, ?2, ?3)')
      .bind(`cn-${year}`, JSON.stringify(data), nowIso()));
  }
  for (const [year, data] of Object.entries(source.hk ?? {})) {
    statements.push(env.DB.prepare('INSERT OR REPLACE INTO raw_data (key, data, updated_at) VALUES (?1, ?2, ?3)')
      .bind(`hk-${year}`, JSON.stringify(data), nowIso()));
  }
  if (statements.length) await env.DB.batch(statements);
  return true;
}

async function loadHolidays(env) {
  const row = await env.DB.prepare('SELECT data FROM holidays WHERE id = 1').first();
  if (row?.data) {
    try {
      return { payload: JSON.parse(row.data), updatedAt: row.updated_at ?? null, fromDb: true };
    } catch {
      /* 落到下面的 assets 兜底 */
    }
  }
  return { payload: null, updatedAt: null, fromDb: false };
}

async function saveHolidays(env, payload) {
  await env.DB.prepare(
    'INSERT INTO holidays (id, data, updated_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2'
  )
    .bind(JSON.stringify(payload), nowIso())
    .run();
}

/* ------------------------------ 节假日更新 ------------------------------ */

const thisYear = () => new Date().getFullYear();

/** 带超时的信号；Node 里定时器会被 unref，Workers 里没有 unref 也无所谓 */
function timeoutSignal(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  timer?.unref?.();
  return ctrl.signal;
}

async function fetchJson(urls, timeout = 15000) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: timeoutSignal(timeout), cf: { cacheTtl: 0 } });
      if (res.status === 404) continue;
      if (!res.ok) continue;
      return await res.json();
    } catch {
      /* 换下一个源 */
    }
  }
  return null;
}

const cnDayCount = (data) => (Array.isArray(data?.days) ? data.days.length : 0);

/**
 * 抓取缺的年份 → 合并 → 存进 D1。
 * @param {number[]} [years] 指定年份；不传就查今年/明年
 */
async function refreshHolidays(env, years) {
  await ensureSchema(env);
  await seedRawFromAssets(env, env.__origin ?? 'https://example.invalid');
  const { cn, hk } = await readRawAll(env);

  const targets = years?.length ? years : [thisYear(), thisYear() + 1];
  const results = [];
  let changed = false;

  for (const year of targets) {
    if (!cnDayCount(cn[String(year)])) {
      const data = await fetchJson([
        `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
        `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
      ]);
      if (data && cnDayCount(data) > 0) {
        cn[String(year)] = data;
        await putRaw(env, `cn-${year}`, data);
        changed = true;
        results.push({ region: 'CN', year, status: 'updated', days: cnDayCount(data) });
      } else {
        results.push({ region: 'CN', year, status: 'not-published' });
      }
    } else {
      results.push({ region: 'CN', year, status: 'already-have' });
    }

    if (!Array.isArray(hk[String(year)]) || hk[String(year)].length === 0) {
      const data = await fetchJson([`https://date.nager.at/api/v3/PublicHolidays/${year}/HK`]);
      if (Array.isArray(data) && data.length) {
        hk[String(year)] = data;
        await putRaw(env, `hk-${year}`, data);
        changed = true;
        results.push({ region: 'HK', year, status: 'updated', days: data.length });
      } else {
        results.push({ region: 'HK', year, status: 'not-published' });
      }
    } else {
      results.push({ region: 'HK', year, status: 'already-have' });
    }
  }

  if (changed) {
    const merged = mergeHolidays(cn, hk);
    const officialCnYears = Object.entries(merged.regions.CN.years)
      .filter(([, v]) => Object.keys(v.days ?? {}).length > 0)
      .map(([y]) => y);
    merged.predictions = buildPredictions(hk, officialCnYears);
    await saveHolidays(env, merged);
  }

  return {
    ok: true,
    checkedAt: nowIso(),
    years: targets,
    results,
    changed: results.filter((r) => r.status === 'updated').map((r) => `${r.region} ${r.year}`),
  };
}

/* -------------------------------- 路由 -------------------------------- */

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === '/api/meta') {
    return json({
      // 云端没有常驻进程，实时推送不可用，前端改为定时拉取
      events: false,
      storage: 'd1',
      needsKey: Boolean(String(env.ACCESS_KEY ?? '').trim()),
    });
  }

  if (!authorized(request, url, env)) {
    return json({ error: 'unauthorized', message: '需要配对链接（缺少或错误的访问密钥）' }, 401);
  }

  if (path === '/api/health') {
    const state = await loadState(env);
    return json({ ok: true, rev: state.rev ?? 0, storage: 'd1' });
  }

  if (path === '/api/state' && request.method === 'GET') {
    const state = await loadState(env);
    // 注意：没有传 rev 时 Number(null) 会得到 0，会被误判成「没变化」，所以必须显式判断
    const rawRev = url.searchParams.get('rev');
    const want = rawRev === null ? NaN : Number(rawRev);
    if (Number.isFinite(want) && want === (state.rev ?? 0)) return json({ unchanged: true, rev: state.rev });
    return json(state);
  }

  if (path === '/api/op' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '请求体不是合法 JSON' }, 400);
    }
    const ops = Array.isArray(body?.ops) ? body.ops : body;
    const state = await loadState(env);
    const result = applyOps(state, ops);
    if (result.applied > 0) await saveState(env, state);
    return json({ ...result, state }, result.errors?.length ? 207 : 200);
  }

  if (path === '/api/events') {
    // 明确告诉前端「这里没有 SSE」，让它直接走轮询
    return json({ error: 'events-not-supported' }, 501);
  }

  if (path === '/api/holidays.json') {
    const { payload } = await loadHolidays(env);
    if (payload) return new Response(JSON.stringify(payload), { headers: { ...API_HEADERS, 'cache-control': 'no-cache' } });
    return env.ASSETS.fetch(new Request(`${url.origin}/data/holidays.json`));
  }

  if (path === '/api/holidays/predict.json') {
    const { payload } = await loadHolidays(env);
    if (payload?.predictions) {
      return new Response(JSON.stringify(payload.predictions), { headers: { ...API_HEADERS, 'cache-control': 'no-cache' } });
    }
    return env.ASSETS.fetch(new Request(`${url.origin}/data/holidays-predict.json`));
  }

  if (path === '/api/holidays' && request.method === 'GET') {
    const { payload, updatedAt, fromDb } = await loadHolidays(env);
    return json({
      generatedAt: payload?.generatedAt ?? null,
      updatedAt,
      fromDb,
      missingYears: payload?.missingYears ?? [],
    });
  }

  if (path === '/api/holidays/update' && request.method === 'POST') {
    return json(await refreshHolidays(env));
  }

  if (path === '/api/share') {
    return json({ enabled: Boolean(String(env.ACCESS_KEY ?? '').trim()), mode: 'cloud', origin: url.origin });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    env.__origin = url.origin;

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    try {
      await ensureSchema(env);
      return await handleApi(request, env, url);
    } catch (err) {
      return json({ error: 'server-error', message: String(err?.message ?? err) }, 500);
    }
  },

  /** 每天定时检查一次节假日数据 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          env.__origin = String(env.PUBLIC_ORIGIN ?? 'https://example.invalid');
          await refreshHolidays(env);
        } catch (err) {
          console.error('[holidays] 定时更新失败：', err?.message ?? err);
        }
      })()
    );
  },
};
