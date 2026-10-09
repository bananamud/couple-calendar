/**
 * 本地把 Cloudflare Worker 跑起来测一遍（不需要 wrangler / npm）。
 *   · 用内存 Map 假装 D1 数据库
 *   · 用 public/ 目录假装静态资源
 * 用法： node tools/test-worker.mjs
 */
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const publicDir = join(root, 'public');

/* ----------------------------- 假的 D1 ----------------------------- */

function createFakeD1() {
  const tables = {
    state: new Map(),
    raw_data: new Map(),
    holidays: new Map(),
  };

  const runStatement = (sql, params) => {
    if (/CREATE TABLE/i.test(sql)) return null;

    if (/INTO state/i.test(sql)) {
      tables.state.set(1, { data: params[0], updated_at: params[1] });
      return null;
    }
    if (/FROM state/i.test(sql)) return tables.state.get(1) ?? null;

    if (/INTO raw_data/i.test(sql)) {
      tables.raw_data.set(params[0], { key: params[0], data: params[1], updated_at: params[2] });
      return null;
    }
    if (/FROM raw_data/i.test(sql)) return [...tables.raw_data.values()];

    if (/INTO holidays/i.test(sql)) {
      tables.holidays.set(1, { data: params[0], updated_at: params[1] });
      return null;
    }
    if (/FROM holidays/i.test(sql)) return tables.holidays.get(1) ?? null;

    throw new Error(`测试台不认识这条 SQL：${sql}`);
  };

  const makeStatement = (sql) => {
    const stmt = {
      params: [],
      bind(...params) {
        stmt.params = params;
        return stmt;
      },
      async first() {
        const row = runStatement(sql, stmt.params);
        return Array.isArray(row) ? row[0] : row;
      },
      async all() {
        const row = runStatement(sql, stmt.params);
        return { results: Array.isArray(row) ? row : [] };
      },
      async run() {
        runStatement(sql, stmt.params);
        return { success: true };
      },
    };
    return stmt;
  };

  return {
    prepare: makeStatement,
    async batch(statements) {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      return out;
    },
  };
}

/* -------------------------- 假的静态资源 -------------------------- */

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
};

const assets = {
  async fetch(request) {
    const url = new URL(request.url);
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(publicDir)) return new Response('forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, { status: 200, headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  },
};

/* ------------------------------ 测试 ------------------------------ */

let passed = 0;
let failed = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

const call = async (path, init = {}, env = {}) => {
  const request = new Request(`https://demo.workers.dev${path}`, init);
  const response = await worker.fetch(request, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  const text = await response.clone().text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 静态文件不是 JSON */
  }
  return { status: response.status, data, text, headers: response.headers };
};

const post = (path, body, env) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);

async function main() {
  console.log('本地 Worker 测试（内存版 D1）\n');
  const env = { DB: createFakeD1(), ASSETS: assets };

  // 1. 基本接口
  let r = await call('/api/meta', {}, env);
  check('GET /api/meta 返回 capabilities', r.status === 200 && r.data?.events === false && r.data?.storage === 'd1');

  r = await call('/api/health', {}, env);
  check('GET /api/health 正常', r.status === 200 && r.data?.ok === true);

  r = await call('/api/state', {}, env);
  check(
    '空库时 GET /api/state 返回默认状态（不是 unchanged）',
    r.status === 200 && !r.data?.unchanged && r.data?.members?.u1?.name === '宝宝',
    JSON.stringify(r.data)
  );

  // 2. 写入
  r = await post(
    '/api/op',
    {
      client: 'test',
      ops: [
        { kind: 'leave.set', user: 'u1', dates: ['2026-11-02'], type: 'annual', note: '测试备注' },
        { kind: 'leave.set', user: 'u2', dates: ['2026-11-02'], type: 'personal' },
        { kind: 'trip.create', trip: { id: 't1', destination: '测试旅行', days: [{ id: 'd1', title: '', note: '' }] } },
        { kind: 'anniv.create', anniv: { id: 'a1', title: '测试纪念日', date: '2025-01-01', emoji: '❤️', repeat: 'yearly' } },
        { kind: 'member.update', id: 'u2', patch: { name: '小粉', region: 'HK', annualTotal: 7 } },
        { kind: 'settings.update', patch: { cnPredict: true } },
      ],
    },
    env
  );
  check('POST /api/op 应用 6 个操作', r.status === 200 && r.data?.applied === 6 && !r.data?.errors?.length, JSON.stringify(r.data?.errors));
  check('操作结果里假期带备注', r.data?.state?.leaves?.['u1|2026-11-02']?.note === '测试备注');
  check('旅行/纪念日已创建', r.data?.state?.trips?.[0]?.destination === '测试旅行' && r.data?.state?.anniversaries?.[0]?.title === '测试纪念日');
  check('成员与设置已更新', r.data?.state?.members?.u2?.name === '小粉' && r.data?.state?.settings?.cnPredict === true);

  // 2.5 纪念日排序（排序模式拖动后保存）
  r = await post('/api/op', { ops: [{ kind: 'anniv.reorder', ids: ['a1'] }] }, env);
  check(
    'anniv.reorder 能保存自定义顺序',
    r.status === 200 && r.data?.state?.anniversaries?.map((a) => `${a.title}:${a.order}`).join(',') === '测试纪念日:0'
  );

  // 3. 读回 + 条件请求
  const rev = r.data.state.rev;
  r = await call('/api/state', {}, env);
  check('数据持久化（模拟的 D1 里能读回）', r.data?.rev === rev && r.data?.leaves?.['u2|2026-11-02']?.type === 'personal');
  r = await call(`/api/state?rev=${rev}`, {}, env);
  check('rev 相同时返回 unchanged', r.data?.unchanged === true);

  // 4. SSE 明确不支持
  r = await call('/api/events', {}, env);
  check('GET /api/events 返回 501（前端会自动改轮询）', r.status === 501);

  // 5. 访问密钥
  const secured = { ...env, ACCESS_KEY: 'secret123' };
  r = await call('/api/state', {}, secured);
  check('配了密钥后无密钥访问被拒（401）', r.status === 401);
  r = await call('/api/state?k=secret123', {}, secured);
  check('带正确密钥可以访问', r.status === 200);
  r = await call('/api/state?k=wrong', {}, secured);
  check('密钥错误被拒（401）', r.status === 401);
  r = await call('/api/meta', {}, secured);
  check('meta 不需要密钥（前端要先知道要不要密钥）', r.status === 200 && r.data?.needsKey === true);

  // 6. 节假日数据（回退到打包文件）
  r = await call('/api/holidays.json', {}, env);
  check('GET /api/holidays.json 回退到打包数据', r.status === 200 && r.data?.regions?.CN?.years?.['2026']?.days?.['2026-10-01']);
  r = await call('/api/holidays/predict.json', {}, env);
  check('GET /api/holidays/predict.json 有预测数据', r.status === 200 && r.data?.regions?.CN?.years?.['2027']);

  // 7. 静态资源
  r = await call('/', {}, env);
  check('根路径返回 index.html', r.status === 200 && r.text.includes('情侣日历'));

  // 8. 节假日自动更新（会联网，失败也算通过，只要结构正确）
  if (process.env.TEST_WORKER_NET === '1') {
    r = await post('/api/holidays/update', {});
    // 注意这一步不能用假 D1，否则种子数据读不到
    console.log('    （联网更新返回：', JSON.stringify(r.data)?.slice(0, 160), '）');
  }

  // 9. 用假 D1 + 真实静态资源跑一次更新：验证「从打包数据播种 → 抓取 → 合并 → 落库」
  const netEnv = { DB: createFakeD1(), ASSETS: assets };
  r = await post('/api/holidays/update', {}, netEnv);
  const okShape = r.status === 200 && r.data?.ok === true && Array.isArray(r.data?.results);
  check('POST /api/holidays/update 结构正确', okShape, JSON.stringify(r.data)?.slice(0, 160));
  if (okShape) {
    const after = await call('/api/holidays.json', {}, netEnv);
    check(
      '更新后 /api/holidays.json 仍能返回完整数据',
      after.status === 200 && Boolean(after.data?.regions?.CN?.years?.['2026']?.days?.['2026-10-01']),
      JSON.stringify(after.data)?.slice(0, 120)
    );
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  // 用 exitCode 而不是 process.exit()：避免在 undici 连接池还在收尾时强退（Windows 上会报 libuv 断言）
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('测试台自己出错了：', err);
  process.exit(1);
});
