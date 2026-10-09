/**
 * 与服务端同步：
 *  - 本地先乐观更新，再提交操作；断网时进本地队列，恢复后自动补发
 *  - SSE 实时接收对方的修改；SSE 断了自动重连，并用轮询兜底
 *  - 回到前台 / 网络恢复时立刻对一次账
 *  - 手机流量下用 ?rev= 做条件请求，没变化时不传整份数据
 */
import { applyOps } from './ops.js';
import { uid } from './util.js';
import { describeChanges } from './diff.js';

const CACHE_KEY = 'cc.state.v1';
const QUEUE_KEY = 'cc.queue.v1';
const ME_KEY = 'cc.me.v1';
const KEY_KEY = 'cc.key.v1';
const CLIENT_KEY = 'cc.client.v1';
const POLL_GAP = 8000;
const WATCHDOG_GAP = 20000;
const SILENT_LIMIT = 45000;

const listeners = new Set();
const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式等忽略 */
  }
};

const defaultState = () => ({
  rev: 0,
  members: {
    u1: { name: '宝宝', region: 'CN', annualTotal: null },
    u2: { name: '宝贝', region: 'HK', annualTotal: null },
  },
  leaves: {},
  trips: [],
  anniversaries: [],
  settings: { cnPredict: false },
});

/** 匹配链接里的 ?k=…，让手机能直接用配对链接打开 */
function readKeyFromUrl() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('k');
    if (fromUrl) {
      localStorage.setItem(KEY_KEY, fromUrl);
      return fromUrl;
    }
  } catch {
    /* ignore */
  }
  return localStorage.getItem(KEY_KEY) ?? '';
}

let clientId = localStorage.getItem(CLIENT_KEY);
if (!clientId) {
  clientId = uid();
  localStorage.setItem(CLIENT_KEY, clientId);
}

export const sync = {
  key: readKeyFromUrl(),
  clientId,
  state: readJson(CACHE_KEY, null) ?? defaultState(),
  me: localStorage.getItem(ME_KEY) === 'u2' ? 'u2' : 'u1',
  status: 'connecting', // connecting | ok | busy | off | locked
  authRequired: false,
  pending: readJson(QUEUE_KEY, []),
  es: null,
  reconnectDelay: 2000,
  reconnectTimer: null,
  lastEventAt: 0,
  lastSyncAt: null,
  pollTimer: null,
  watchdogTimer: null,
  retryTimer: null,
  eventsSupported: true, // 云端部署没有常驻进程，会通过 /api/meta 告诉前端
  pollGap: POLL_GAP,

  /* ------------------------------ 基础 ------------------------------ */

  api(path, params = {}) {
    const url = new URL(path, location.href.split('#')[0]);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (this.key) url.searchParams.set('k', this.key);
    return url.toString();
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** extra 非空时会作为「对方刚更新」的事件一起传出去 */
  emit(extra = null) {
    writeJson(CACHE_KEY, this.state);
    for (const fn of listeners) fn(this, extra);
  },

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  },

  setMe(id) {
    this.me = id === 'u2' ? 'u2' : 'u1';
    localStorage.setItem(ME_KEY, this.me);
    this.emit();
  },

  /** 另一个人（这台手机上不是「我」的那位） */
  other(id = this.me) {
    return id === 'u1' ? 'u2' : 'u1';
  },

  /* ------------------------------ 状态 ------------------------------ */

  applyLocal(ops) {
    this.state = applyOps(this.state, ops);
  },

  adopt(serverState) {
    if (!serverState) return null;
    const changes = describeChanges(this.state, serverState);
    this.state = serverState;
    // 服务端状态是最新的，但本地还有没提交成功的操作要叠加回来
    for (const batch of this.pending) this.state = applyOps(this.state, batch.ops);
    return changes;
  },

  /** 这次改动如果确实是对方做的，就抛一个提示事件 */
  reportRemoteChange(changes) {
    if (!changes) return;
    const last = this.state.lastChange;
    if (!last || last.client === this.clientId) return;
    this.emit({ remote: changes, at: last.at });
  },

  async fetchState() {
    const params = this.state?.rev ? { rev: String(this.state.rev) } : {};
    const res = await fetch(this.api('./api/state', params), { cache: 'no-store' });
    if (res.status === 401) {
      this.authRequired = true;
      this.setStatus('locked');
      throw new Error('需要配对链接');
    }
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    this.authRequired = false;
    if (data?.unchanged) {
      this.lastSyncAt = Date.now();
      return null;
    }
    const changes = this.adopt(data);
    this.lastSyncAt = Date.now();
    return changes;
  },

  async syncNow() {
    const changes = await this.fetchState();
    await this.flush();
    this.reportRemoteChange(changes);
    if (!this.authRequired) this.setStatus('ok');
  },

  /* ------------------------------ 提交 ------------------------------ */

  async dispatch(ops) {
    const list = Array.isArray(ops) ? ops : [ops];
    const batch = { id: uid(), ops: list, at: Date.now() };
    this.pending.push(batch);
    writeJson(QUEUE_KEY, this.pending);
    this.applyLocal(list);
    this.setStatus('busy');
    this.emit();
    await this.flush();
  },

  async flush() {
    // 单飞：一次只允许一个提交流程，避免 SSE 回包 / dispatch 并发触发重复提交
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      await this.flushLoop();
    } finally {
      this.flushing = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        await this.flush();
      }
    }
  },

  async flushLoop() {
    if (!this.pending.length) {
      if (!this.authRequired) this.setStatus('ok');
      return;
    }
    while (this.pending.length) {
      const batch = this.pending[0];
      try {
        const res = await fetch(this.api('./api/op'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ops: batch.ops, client: this.clientId }),
        });
        if (res.status === 401) {
          this.authRequired = true;
          this.setStatus('locked');
          return;
        }
        const data = await res.json().catch(() => null);
        if (!res.ok && res.status !== 207) throw new Error(data?.error ?? `HTTP ${res.status}`);
        if (data?.state) {
          this.state = data.state;
          for (const b of this.pending.slice(1)) this.state = applyOps(this.state, b.ops);
        }
        this.pending.shift();
        writeJson(QUEUE_KEY, this.pending);
        this.lastSyncAt = Date.now();
        this.emit();
        if (data?.errors?.length) console.warn('[sync] 服务端拒绝了部分操作：', data.errors);
      } catch (err) {
        console.warn('[sync] 提交失败，稍后重试：', err.message);
        this.setStatus('off');
        this.scheduleRetry();
        return;
      }
    }
    if (!this.authRequired) this.setStatus('ok');
  },

  scheduleRetry(delay = 4000) {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flush();
    }, delay);
  },

  /* --------------------------- SSE + 兜底 --------------------------- */

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      try {
        const changes = await this.fetchState();
        await this.flush();
        this.reportRemoteChange(changes);
      } catch {
        if (!this.authRequired) this.setStatus('off');
      }
    }, this.pollGap);
  },

  stopPolling() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  },

  connectEvents() {
    if (!('EventSource' in globalThis) || !this.eventsSupported) {
      this.startPolling();
      return;
    }
    if (this.es) {
      try {
        this.es.close();
      } catch {
        /* ignore */
      }
    }
    const es = new EventSource(this.api('./api/events'));
    this.es = es;

    es.addEventListener('state', (e) => {
      try {
        const changes = this.adopt(JSON.parse(e.data));
        this.lastEventAt = Date.now();
        this.lastSyncAt = Date.now();
        this.reconnectDelay = 2000;
        this.stopPolling();
        if (this.pending.length) this.flush();
        else if (!this.authRequired) this.setStatus('ok');
        this.reportRemoteChange(changes);
        this.emit();
      } catch (err) {
        console.error('[sync] 处理推送时出错：', err);
      }
    });

    es.onopen = () => {
      this.lastEventAt = Date.now();
      this.stopPolling();
      if (!this.pending.length && !this.authRequired) this.setStatus('ok');
    };

    es.onerror = () => {
      // 不永久降级成轮询：先用轮询兜底，同时按退避重连 SSE
      this.lastEventAt = this.lastEventAt || Date.now();
      if (!this.authRequired) this.setStatus('off');
      this.startPolling();
      this.scheduleReconnect();
    };
  },

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      if (!this.lastEventAt || Date.now() - this.lastEventAt > 5000) this.connectEvents();
    }, this.reconnectDelay);
  },

  /** SSE 静默太久（手机切网/休眠很常见）就主动对一次账 */
  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(async () => {
      if (document.hidden) return;
      if (this.lastEventAt && Date.now() - this.lastEventAt < SILENT_LIMIT) return;
      try {
        const changes = await this.fetchState();
        await this.flush();
        this.reportRemoteChange(changes);
        if (!this.es || this.es.readyState === 2) this.connectEvents();
      } catch {
        if (!this.authRequired) this.setStatus('off');
      }
    }, WATCHDOG_GAP);
  },

  /* ------------------------------ 启动 ------------------------------ */

  async init() {
    this.emit();
    // 先问一下服务端支持什么（云端版没有 SSE，就用定时拉取）
    try {
      const res = await fetch(this.api('./api/meta'), { cache: 'no-store' });
      if (res.ok) {
        const meta = await res.json();
        if (meta?.events === false) {
          this.eventsSupported = false;
          this.pollGap = 20000; // 云端按 20 秒拉一次，省请求数
        }
      }
    } catch {
      /* 老版本服务端没有这个接口，按支持 SSE 处理 */
    }
    try {
      await this.fetchState();
      await this.flush();
      if (!this.authRequired) this.setStatus('ok');
    } catch {
      if (!this.authRequired) {
        this.setStatus('off');
        this.startPolling();
      }
    }
    this.connectEvents();
    this.startWatchdog();

    globalThis.addEventListener('online', () => this.syncNow().catch(() => {}));
    globalThis.addEventListener('offline', () => this.setStatus('off'));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.lastEventAt = 0; // 让看门狗下一轮立刻对账
        this.syncNow().catch(() => {});
      }
    });
    globalThis.addEventListener('pageshow', (e) => {
      if (e.persisted) this.syncNow().catch(() => {});
    });
    globalThis.addEventListener('focus', () => {
      if (this.status === 'off') this.syncNow().catch(() => {});
    });
    globalThis.__sync = this; // 调试用：控制台里可以直接查看同步状态
  },
};
