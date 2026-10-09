/**
 * 把日历分享到公网，让你们不在同一个 Wi-Fi 时也能互相同步。
 *
 *   · 用 cloudflared 免费隧道（不需要注册账号），生成带访问密钥的配对链接
 *   · 隧道断了会自动重连；地址变了会重新打印一条新的配对链接
 *   · 分享期间会阻止电脑自动休眠（否则电脑一睡，公网地址就断了）
 *
 * 用法： node tools/share.mjs          （可加 --reset-key 换一把新钥匙）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, platform } from 'node:os';
import net from 'node:net';
import { loadShare, saveShare, newToken } from '../src/share.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 5178);
const resetKey = process.argv.includes('--reset-key');
const noKeepAwake = process.argv.includes('--no-keep-awake');
// 自检间隔（默认 60 秒；调试时可以调短，例如 CC_HEALTH_MS=3000）
const healthInterval = Math.max(1000, Number(process.env.CC_HEALTH_MS ?? 60000));

const CLOUDFLARED_CANDIDATES = [
  join(root, 'tools', 'bin', 'cloudflared.exe'),
  join(root, 'tools', 'bin', 'cloudflared'),
];
let cloudflaredPath = CLOUDFLARED_CANDIDATES.find((p) => existsSync(p)) ?? '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const log = (...args) => console.log(...args);
let stopping = false;
let currentUrl = '';
let lastUrl = ''; // 上一次成功过的地址（断开也不清空，用来判断「地址变了」）
let tunnelProcess = null;
let serverProcess = null;
let healthFailures = 0;
let rebuiltWithoutSuccess = 0; // 连续重建但自检始终不通的次数
let dnsHintShown = false; // 只提示一次 DNS 污染的解决办法

/** 这些是 Cloudflare 自己的域名，不是隧道地址（最容易误判的是 api.trycloudflare.com） */
const RESERVED_SUBDOMAINS = new Set([
  'api', 'www', 'trycloudflare', 'cloudflare', 'developers', 'support', 'update',
  'login', 'dash', 'one', 'blog', 'docs', 'help', 'status', 'community', 'cdn',
]);

/**
 * 从 cloudflared 的输出里挑出真正的隧道地址。
 * 真正的快速隧道域名长这样：gotta-ground-caps-seq.trycloudflare.com（一定是几个词用短横线连起来），
 * 而 cloudflared 日志里还会出现它自己调用的 api.trycloudflare.com，必须排除。
 */
function parseTunnelUrl(text) {
  const candidates = [];
  // 优先取 cloudflared 正式打印的那一行："INF |  https://xxx.trycloudflare.com"
  const lineMatch = text.match(/\|\s+(https:\/\/[a-z0-9.-]+\.trycloudflare\.com)/i);
  if (lineMatch) candidates.push(lineMatch[1]);
  for (const m of text.matchAll(/https:\/\/[a-z0-9.-]+\.trycloudflare\.com/gi)) candidates.push(m[0]);

  for (const url of candidates) {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const sub = host.replace(/\.trycloudflare\.com$/, '');
    if (RESERVED_SUBDOMAINS.has(sub)) continue;
    if (!sub.includes('-')) continue; // 随机隧道名一定带短横线，单段域名都是官方接口
    return `https://${host}`;
  }
  return null;
}

/* ------------------------------ 环境准备 ------------------------------ */

/** 找不到就自动下载一份（只需要一次） */
async function ensureCloudflared() {
  if (cloudflaredPath) return cloudflaredPath;
  if (platform() !== 'win32') {
    console.error('  没找到 cloudflared，请先安装（macOS: brew install cloudflared / Linux: 见官方文档）');
    process.exit(1);
  }
  const dest = CLOUDFLARED_CANDIDATES[0];
  console.log('  · 首次使用需要下载隧道工具 cloudflared（约 50MB，只下载一次）…');
  const res = await fetch(
    'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    { redirect: 'follow' }
  );
  if (!res.ok) {
    console.error(`  下载失败（HTTP ${res.status}）。可以手动下载后放到 tools/bin/cloudflared.exe`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  cloudflaredPath = dest;
  console.log('  · 下载完成');
  return dest;
}

/**
 * 分享期间不让电脑自动休眠。
 * 原理：SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)，
 * 只在这个进程活着时有效，关掉窗口就恢复原来的电源策略（注意：笔记本合盖仍然会睡）。
 */
function keepAwake() {
  if (noKeepAwake || platform() !== 'win32') return;
  const script = [
    "Add-Type -Namespace Cc -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    '[Cc.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null',
    'while ($true) { Start-Sleep -Seconds 30 }',
  ].join('; ');
  try {
    const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    });
    children.push(child);
    log('  · 已阻止电脑自动休眠（关掉这个窗口即恢复）');
  } catch {
    log('  · 未能设置防休眠（不影响使用，注意别让电脑睡着）');
  }
}

/* ------------------------------ 服务与隧道 ------------------------------ */

async function serverAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function startServer() {
  log('  · 正在启动日历服务…');
  serverProcess = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'inherit' });
  children.push(serverProcess);
  serverProcess.on('exit', (code) => {
    if (stopping || code === 0) return;
    console.log(`\n  ⚠️ 日历服务意外退出（退出码 ${code}），3 秒后自动重启…`);
    setTimeout(async () => {
      if (stopping) return;
      if (await serverAlive()) return;
      startServer();
    }, 3000);
  });
  return serverProcess;
}

const lanUrls = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${port}`);

function banner(link, token, isNew) {
  const line = '─'.repeat(58);
  console.log('');
  console.log(line);
  console.log(isNew ? '  ⚠️  公网地址变了！旧链接已失效，请把新链接重新发给对方' : '  ❤️  情侣日历 · 公网模式已开启');
  console.log(line);
  console.log('');
  console.log('  配对链接（发给对方，用手机浏览器打开）：');
  console.log('');
  console.log(`    ${link}`);
  console.log('');
  console.log('  · 链接里带了访问密钥，谁拿到链接谁就能看到日历，别发到公开群里。');
  console.log('  · 想换一把新钥匙：关掉窗口，改用  node tools/share.mjs --reset-key');
  console.log('  · 同一个 Wi-Fi 时也可以直接用： ' + lanUrls().join('  '));
  console.log('  · iPhone 用 Safari 打开后「添加到主屏幕」，Android 用 Chrome「安装应用」。');
  console.log('');
  console.log('  ⚠️  这个窗口关掉、电脑休眠，或长时间断网，公网地址都会失效；');
  console.log('      隧道断了这边会自动重连，如果需要长期稳定在线，请看 README 的云端部署。');
  console.log('');
  console.log(`  访问密钥：${token}`);
  console.log('');
}

function handleTunnelOutput(buf) {
  const text = String(buf);
  const url = parseTunnelUrl(text);
  if (!url) {
    // 把 cloudflared 自己的报错也打出来，否则隧道建不起来时完全看不到原因
    for (const line of text.split('\n')) {
      const clean = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, '').trim();
      if (!clean) continue;
      if (/(ERR|WARN|failed|error|denied|refused|unable)/i.test(clean)) {
        console.log(`  [cloudflared] ${clean.slice(0, 200)}`);
        if (/x509|certificate|unknown authority/i.test(clean) && !dnsHintShown) {
          dnsHintShown = true;
          console.log('');
          console.log('  💡 这个报错说明 api.trycloudflare.com 被解析到了伪造 IP（DNS 污染），证书验不过，');
          console.log('     所以隧道建不起来。解决办法：双击项目里的「修复隧道DNS.bat」，');
          console.log('     它只把这一个域名固定到真实的 Cloudflare IP（随时可以删掉那一行恢复原状）。');
          console.log('     或者打开代理软件，让 *.trycloudflare.com 走代理节点。');
          console.log('');
        }
      }
    }
    return;
  }
  if (url === currentUrl) return;
  const isNew = Boolean(lastUrl) && lastUrl !== url;
  currentUrl = url;
  lastUrl = url;
  healthFailures = 0;
  const token = loadShare(root).token;
  saveShare(root, { enabled: true, token, publicUrl: url, port });
  banner(`${url}/?k=${token}`, token, isNew);
}

/**
 * 依次尝试的连接方式。国内网络常见两种拦截：
 *   · UDP/QUIC 被限速或切断 → 换 HTTP/2（走 TCP）
 *   · trycloudflare.com 被 DNS 投毒 → 走本机代理（代理在远端解析，拿不到假 IP）
 */
const ATTEMPTS = [
  { label: '直连', args: [], proxy: false },
  { label: '直连 + HTTP/2', args: ['--protocol', 'http2'], proxy: false },
  { label: '走本机代理', args: [], proxy: true },
  { label: '走本机代理 + HTTP/2', args: ['--protocol', 'http2'], proxy: true },
];
let attemptIndex = 0;
let proxyPort = 0;

/** 探测本机常见代理端口（Clash / v2ray / Shadowsocks 等） */
function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 400 });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
  });
}

async function detectLocalProxy() {
  if (proxyPort) return proxyPort;
  for (const port of [7890, 7891, 7892, 7897, 1080, 10809, 10808, 8889, 2080, 33210]) {
    if (await canConnect(port)) {
      // 再确认一次，避免刚好碰到正在关闭的端口
      await new Promise((r) => setTimeout(r, 150));
      if (!(await canConnect(port))) continue;
      proxyPort = port;
      return port;
    }
  }
  return 0;
}

async function launchTunnel(reason) {
  if (stopping) return;
  await ensureCloudflared();
  if (stopping) return;

  const attempt = ATTEMPTS[Math.min(attemptIndex, ATTEMPTS.length - 1)];
  const env = { ...process.env };
  if (attempt.proxy) {
    const proxy = await detectLocalProxy();
    if (!proxy) {
      // 本机没有代理可用，跳过这一档
      attemptIndex = Math.min(attemptIndex + 1, ATTEMPTS.length - 1);
      return launchTunnel(reason);
    }
    env.HTTPS_PROXY = `http://127.0.0.1:${proxy}`;
    env.HTTP_PROXY = env.HTTPS_PROXY;
  }

  if (reason) log(`  · ${reason}`);
  log(`  · 正在建立公网隧道（${attempt.label}${attempt.proxy && proxyPort ? ` 127.0.0.1:${proxyPort}` : ''}）…`);
  const child = spawn(cloudflaredPath, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', ...attempt.args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  tunnelProcess = child;
  children.push(child);
  let switching = false; // 主动换下一种方式时，别让 exit 处理器又重连一次

  // 25 秒还没拿到地址，就换下一种方式（直连 → 直连HTTP/2 → 代理 → 代理HTTP/2）
  const failTimer = setTimeout(() => {
    if (stopping || currentUrl) return;
    if (attemptIndex >= ATTEMPTS.length - 1) return;
    switching = true;
    attemptIndex += 1;
    console.log(`  · 「${attempt.label}」25 秒内没能建立隧道，改用「${ATTEMPTS[attemptIndex].label}」…`);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }, 25000);
  failTimer.unref?.();

  child.stdout.on('data', handleTunnelOutput);
  child.stderr.on('data', handleTunnelOutput);
  child.on('exit', (code) => {
    clearTimeout(failTimer);
    if (stopping) return;
    if (switching) {
      setTimeout(() => launchTunnel(''), 500);
      return;
    }
    currentUrl = '';
    saveShare(root, { enabled: false });
    if (!lastUrl && attemptIndex < ATTEMPTS.length - 1) {
      attemptIndex += 1;
      console.log(`\n  ⚠️ ${attempt.label} 建不起来（退出码 ${code}），换「${ATTEMPTS[attemptIndex].label}」重试…`);
      setTimeout(() => launchTunnel(''), 3000);
    } else {
      console.log(`\n  ⚠️ 公网隧道断开（退出码 ${code}），5 秒后自动重连…`);
      setTimeout(() => launchTunnel('重新建立隧道'), 5000);
    }
  });
  return child;
}

/** 每 60 秒自检一次公网地址；连续 3 次不通就重建隧道 */
function startHealthCheck() {
  setInterval(async () => {
    if (stopping || !currentUrl) return;
    const token = loadShare(root).token;
    try {
      const res = await fetch(`${currentUrl}/api/health?k=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(15000),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      healthFailures = 0;
      rebuiltWithoutSuccess = 0; // 自检通过，说明地址是好的
    } catch (err) {
      healthFailures += 1;
      console.log(`  · 公网地址自检失败（${healthFailures}/3）：${err.message}`);
      if (healthFailures >= 3) {
        healthFailures = 0;
        // 先分清是「本地服务挂了」还是「隧道挂了」——前者重建隧道没用
        if (!(await serverAlive())) {
          console.log('  · 本地服务没有响应，正在重启本地服务…');
          try {
            serverProcess?.kill();
          } catch {
            /* ignore */
          }
          setTimeout(() => {
            if (!stopping) startServer();
          }, 1000);
        } else if (rebuiltWithoutSuccess >= 6) {
          // 兜底：反复重建还是不通就别再死循环了，给出人话建议
          console.log('');
          console.log('  ⚠️  公网地址连续 6 次重建后仍然打不通，先停止自动重建。');
          console.log('      可能原因：当前网络屏蔽了 Cloudflare，或者电脑的防火墙拦住了出口。');
          console.log('      可以这样处理：① 手机连同一个 Wi-Fi，直接用上面的局域网地址；');
          console.log('      ② 关掉这个窗口改用「启动情侣日历.bat」；③ 需要异地访问就上云端部署（见 README）。');
          console.log('');
        } else {
          rebuiltWithoutSuccess += 1;
          console.log(`  · 本地服务正常、公网地址不通，正在重建隧道（第 ${rebuiltWithoutSuccess} 次）…`);
          try {
            tunnelProcess?.kill();
          } catch {
            /* ignore */
          }
        }
      }
    }
  }, healthInterval);
}

/* ------------------------------- 主流程 ------------------------------- */

let share = loadShare(root);
if (resetKey || !share.token) {
  share = saveShare(root, { token: newToken() });
  log('  · 已生成新的访问密钥');
}

keepAwake();

if (!(await serverAlive())) {
  startServer();
  for (let i = 0; i < 40 && !(await serverAlive()); i++) await sleep(250);
  if (!(await serverAlive())) {
    console.error(`  日历服务没能在端口 ${port} 上启动，请先在项目目录运行 node server.js 看看报错。`);
    for (const c of children) c.kill();
    process.exit(1);
  }
} else {
  log('  · 检测到日历服务已经在运行');
}

await launchTunnel('');
startHealthCheck();

setTimeout(() => {
  if (!currentUrl) console.log('  · 隧道还在连接中…如果一直没反应，多半是当前网络屏蔽了 Cloudflare。');
}, 20000);

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  saveShare(root, { enabled: false });
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => {
  console.log('\n  正在关闭…');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
