/**
 * 开发用：无头 Chrome 打开页面 → 执行自定义 JS → 截图 / 输出结果。
 * 依赖本机已安装 Chrome，不影响 App 本身运行。
 *
 * 用法：
 *   node tools/devshot.mjs --url "http://localhost:5178/#/calendar" --out ".shots/calendar.png"
 *   node tools/devshot.mjs --eval "document.body.innerText.slice(0,500)"
 *   node tools/devshot.mjs --click "text=旅行" --wait 800 --out ".shots/trips.png"
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(getArg('port', '9333'));
const url = getArg('url', 'http://localhost:5178/#/calendar');
const out = getArg('out', '');
let evalExpr = getArg('eval', '');
const evalFile = getArg('evalFile', '');
if (evalFile) evalExpr = readFileSync(join(root, evalFile), 'utf8');
const clickText = getArg('click', '');
const waitMs = Number(getArg('wait', '1500'));
const width = Number(getArg('width', '430'));
const height = Number(getArg('height', '932'));

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome / Edge');
  process.exit(1);
}

// --profile <名字> 时复用同一个浏览器配置（用来测试 Service Worker 离线缓存）
const keepProfile = getArg('profile', '');
const profile = keepProfile ? join(root, '.tmp', keepProfile) : join(tmpdir(), `cc-devshot-${port}`);
if (!keepProfile) rmSync(profile, { recursive: true, force: true });

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('DevTools 端口未就绪');
}

async function newTarget(targetUrl) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`创建标签页失败: ${res.status}`);
  return res.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      for (const fn of [...events.get(msg.method)]) fn(msg.params);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return {
    ready,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    on(method, handler) {
      if (!events.has(method)) events.set(method, new Set());
      events.get(method).add(handler);
      return () => events.get(method)?.delete(handler);
    },
    once(method) {
      return new Promise((resolve) => {
        const off = this.on(method, (params) => {
          off();
          resolve(params);
        });
      });
    },
    close: () => ws.close(),
  };
}

const cleanup = () => {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
};

try {
  await waitForDevtools();
  const target = await newTarget('about:blank');
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (args.includes('--console')) {
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      if (p.type === 'error' || p.type === 'warning') console.log(`[page:${p.type}] ${text}`);
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails ?? {};
      console.log(`[page:error] ${d.text ?? ''} ${d.exception?.description ?? ''}`);
    });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(8000)]);
  await sleep(waitMs);

  if (clickText) {
    const sel = clickText.startsWith('text=') ? clickText.slice(5) : clickText;
    const expr = `(() => {
      const all = [...document.querySelectorAll('button, a, .list-item, .trip-card')];
      const hit = all.find((el) => el.textContent.includes(${JSON.stringify(sel)}));
      if (!hit) return '未找到: ' + ${JSON.stringify(sel)};
      hit.click();
      return '已点击: ' + hit.textContent.trim().slice(0, 30);
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(r.result.value);
    await sleep(waitMs);
  }

  if (evalExpr) {
    const r = await cdp.send('Runtime.evaluate', { expression: evalExpr, returnByValue: true, awaitPromise: true });
    const v = r.result.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }

  if (out) {
    const shotParams = {
      format: 'png',
      captureBeyondViewport: args.includes('--full'),
    };
    const clipArg = getArg('clip', '');
    if (clipArg) {
      const [x, y, width, height] = clipArg.split(',').map(Number);
      shotParams.clip = { x, y, width, height, scale: Number(getArg('scale', '2')) };
    }
    const shot = await cdp.send('Page.captureScreenshot', shotParams);
    const file = join(root, out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`已保存 ${out}`);
  }
  cdp.close();
} catch (err) {
  console.error('出错：', err.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
