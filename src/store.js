/**
 * 本地（局域网 / 电脑当服务器）用的 JSON 文件存储 + 状态管理。
 * 纯逻辑部分（默认状态、操作应用）在 src/ops-core.js，和 Cloudflare Worker 共用。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyOps, defaultState, normalizeTrip, normalizeAnniversary, isObj } from './ops-core.js';

export { applyOps, defaultState, LEAVE_TYPES } from './ops-core.js';

/** 数据目录可用环境变量 DATA_DIR 指定（云端部署挂载卷时很有用） */
export const dataDir = (root) => process.env.DATA_DIR || join(root, 'data');
export const storeFile = (root) => join(dataDir(root), 'store.json');

export class Store {
  constructor(file) {
    this.file = file;
    this.state = defaultState();
    this.timer = null;
    this.listeners = new Set();
    this.load();
  }

  load() {
    if (!existsSync(this.file)) {
      this.save();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      const base = defaultState();
      this.state = {
        ...base,
        ...parsed,
        members: { ...base.members, ...(parsed.members ?? {}) },
        leaves: isObj(parsed.leaves) ? parsed.leaves : {},
        trips: Array.isArray(parsed.trips) ? parsed.trips.map((t) => normalizeTrip(t)) : [],
        anniversaries: Array.isArray(parsed.anniversaries)
          ? parsed.anniversaries.map((a) => normalizeAnniversary(a)).filter((a) => a.date)
          : [],
        settings: { ...base.settings, ...(isObj(parsed.settings) ? parsed.settings : {}) },
      };
    } catch (err) {
      console.error('[store] 读取失败，使用空数据：', err.message);
      this.state = defaultState();
    }
  }

  save() {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }

  scheduleSave() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.save();
      } catch (err) {
        console.error('[store] 写入失败：', err.message);
      }
    }, 250);
    this.timer.unref?.();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  apply(ops, meta = {}) {
    const result = applyOps(this.state, ops);
    if (result.applied > 0) {
      // 记录这次改动来自哪台设备，便于另一台设备提示「TA 刚刚更新了…」
      this.state.lastChange = {
        client: typeof meta.client === 'string' ? meta.client.slice(0, 64) : '',
        at: new Date().toISOString(),
        kinds: [...new Set((Array.isArray(ops) ? ops : []).map((o) => o?.kind).filter(Boolean))],
      };
      this.scheduleSave();
      for (const fn of this.listeners) fn(this.state);
    }
    return result;
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }
}
