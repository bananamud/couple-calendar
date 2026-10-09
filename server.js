/**
 * 情侣日历服务端：静态资源 + 状态同步 API（零第三方依赖）。
 * 启动：node server.js   （可用环境变量 PORT 指定端口，默认 5178）
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { Store, storeFile } from './src/store.js';
import { loadShare, tokenMatches, isLoopback } from './src/share.js';
import { updateHolidays, missingYears as missingHolidayYearsList } from './src/update-holidays.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(root, 'public');
const port = Number(process.env.PORT ?? 5178);

const store = new Store(storeFile(root));
const holidaysJson = resolve(root, 'public', 'data', 'holidays.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const sendJson = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/* ------------------------------- 静态资源 ------------------------------- */

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = resolve(join(publicDir, normalize(rel)));
  if (target !== publicDir && !target.startsWith(publicDir + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('is dir');
    const body = await readFile(target);
    const immutable = /\.(png|svg|woff2)$/i.test(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': immutable ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

/* --------------------------------- API --------------------------------- */

const clients = new Set();

/* --------------------------- 节假日数据自动更新 --------------------------- */

let holidayUpdate = { running: false, lastRun: null, lastResult: null };

async function holidayMeta() {
  try {
    return JSON.parse(await readFile(holidaysJson, 'utf8'));
  } catch {
    return null;
  }
}

/** 还缺哪几年的官方数据 */
const missingHolidayYears = async () => missingHolidayYearsList(root);

/** 跑一次更新（同一进程内完成） */
async function runHolidayUpdate(years = []) {
  if (holidayUpdate.running) return { ok: false, error: '正在更新中' };
  holidayUpdate.running = true;
  try {
    const summary = await updateHolidays(root, {
      years,
      log: (msg) => console.log(`[节假日] ${msg}`),
    });
    const result = { ok: true, ...summary };
    holidayUpdate.lastResult = result;
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    holidayUpdate.lastResult = result;
    return result;
  } finally {
    // 无论成功、失败还是抛异常，都要复位，避免一直卡在「正在更新」
    holidayUpdate.running = false;
    holidayUpdate.lastRun = new Date().toISOString();
  }
}

/** 启动时 + 每 24 小时检查一次；只有确实缺数据才联网拉取 */
async function autoUpdateHolidays() {
  try {
    const missing = await missingHolidayYears();
    if (!missing.length) return;
    console.log(`[节假日] 缺少 ${missing.join('、')} 年的官方数据，正在尝试自动更新…`);
    const result = await runHolidayUpdate(missing);
    if (result.ok && result.changed?.length) {
      console.log(`[节假日] 已更新：${result.changed.join('、')}`);
    } else {
      console.log('[节假日] 暂时没有可用的新数据（官方可能还没公布）');
    }
  } catch (err) {
    console.warn('[节假日] 自动更新失败：', err.message);
  }
}

function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(store.state)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

store.onChange(broadcast);

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  res.write(`event: state\ndata: ${JSON.stringify(store.state)}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);
  heartbeat.unref?.();
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

async function handleApi(req, res, pathname, url) {
  if (pathname === '/api/meta' && req.method === 'GET') {
    sendJson(res, 200, {
      events: true, // 本机版有常驻进程，支持 SSE 实时推送
      storage: 'file',
      needsKey: Boolean((process.env.ACCESS_KEY ?? '').trim()),
    });
    return true;
  }

  // 前端优先通过接口取节假日数据（云端版会返回数据库里的最新数据）
  if ((pathname === '/api/holidays.json' || pathname === '/api/holidays-predict.json') && req.method === 'GET') {
    const file = pathname.endsWith('predict.json') ? 'holidays-predict.json' : 'holidays.json';
    try {
      const body = await readFile(resolve(root, 'public', 'data', file));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: 'not found' });
    }
    return true;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    // 没传 rev 时 Number(null) 会是 0，必须显式判断，否则空状态会被当成「没变化」
    const rawRev = url.searchParams.get('rev');
    const wantRev = rawRev === null ? NaN : Number(rawRev);
    if (Number.isFinite(wantRev) && wantRev === store.state.rev) {
      sendJson(res, 200, { unchanged: true, rev: store.state.rev });
      return true;
    }
    sendJson(res, 200, store.state);
    return true;
  }

  if (pathname === '/api/share' && req.method === 'GET') {
    const share = loadShare(root);
    const envKey = (process.env.ACCESS_KEY ?? '').trim();
    const lan = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i.address}:${port}`);
    sendJson(res, 200, {
      enabled: share.enabled || Boolean(envKey),
      publicUrl: share.publicUrl || '',
      token: envKey || share.token,
      updatedAt: share.updatedAt,
      origin: `${url.protocol}//${url.host}`,
      mode: envKey ? 'cloud' : share.enabled ? 'tunnel' : 'lan',
      lanUrls: [`http://localhost:${port}`, ...lan],
    });
    return true;
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    handleEvents(req, res);
    return true;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, rev: store.state.rev, clients: clients.size });
    return true;
  }

  if (pathname === '/api/holidays' && req.method === 'GET') {
    const meta = await holidayMeta();
    sendJson(res, 200, {
      generatedAt: meta?.generatedAt ?? null,
      missingYears: await missingHolidayYears(),
      updating: holidayUpdate.running,
      lastRun: holidayUpdate.lastRun,
      lastResult: holidayUpdate.lastResult,
    });
    return true;
  }

  if (pathname === '/api/holidays/update' && req.method === 'POST') {
    const missing = await missingHolidayYears();
    const result = await runHolidayUpdate(missing.length ? missing : []);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/op' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const ops = Array.isArray(body.ops) ? body.ops : body;
      const result = store.apply(ops, { client: body.client });
      sendJson(res, result.errors.length ? 207 : 200, { ...result, state: store.state });
    } catch (err) {
      sendJson(res, 400, { error: String(err.message ?? err) });
    }
    return true;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  return false;
}

/* ------------------------------- 启动服务 ------------------------------- */

/** 开启了分享（有密钥）时，非本机访问必须带 ?k= 或 x-cc-key 头 */
function authorized(req, url) {
  const envKey = (process.env.ACCESS_KEY ?? '').trim();
  if (envKey) {
    if (isLoopback(req)) return true;
    const provided = url.searchParams.get('k') ?? req.headers['x-cc-key'];
    return tokenMatches(envKey, typeof provided === 'string' ? provided : '');
  }
  const share = loadShare(root);
  if (!share.enabled) return true;
  if (isLoopback(req)) return true;
  const provided = url.searchParams.get('k') ?? req.headers['x-cc-key'];
  return tokenMatches(share.token, typeof provided === 'string' ? provided : '');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      if (!authorized(req, url)) {
        sendJson(res, 401, { error: 'unauthorized', message: '需要配对链接（缺少或错误的访问密钥）' });
        return;
      }
      const handled = await handleApi(req, res, pathname, url);
      if (!handled) sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err.message}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，可用 PORT=其他端口 再运行，例如：PORT=5179 node server.js`);
  } else {
    console.error('[server] 出错：', err);
  }
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('');
  console.log('  ❤️  情侣日历已启动（这个窗口不要关，关了 App 就停了）');
  console.log('');
  console.log(`  电脑上打开：  http://localhost:${port}`);
  if (lan.length) {
    console.log('  手机上打开：');
    for (const ip of lan) console.log(`      http://${ip}:${port}    ← 手机要连同一个 Wi-Fi`);
  } else {
    console.log('  手机上打开：未检测到局域网地址，请确认电脑已连上 Wi-Fi');
  }
  console.log('');
  console.log('  提示：不要直接双击 public/index.html，那样打不开，必须通过这个服务访问。');
  console.log(`  数据文件：${storeFile(root)}`);
  console.log('');

  // 启动后 20 秒检查一次节假日数据，之后每 24 小时一次
  setTimeout(autoUpdateHolidays, 20000);
  setInterval(autoUpdateHolidays, 24 * 60 * 60 * 1000).unref?.();
});

const shutdown = () => {
  try {
    store.flush();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
