/**
 * 分享/配对配置：data/share.json
 * 隧道的公网地址是不公开就会被扫到的，所以一旦开启分享就带上访问密钥（k）。
 * 本机（127.0.0.1）访问永远不需要密钥，方便电脑上直接用。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dataDir } from './store.js';

export const shareFile = (root) => join(dataDir(root), 'share.json');

export function loadShare(root) {
  const file = shareFile(root);
  if (!existsSync(file)) return { enabled: false, token: '', publicUrl: '', port: null, updatedAt: null };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return {
      enabled: Boolean(data.enabled && data.token),
      token: typeof data.token === 'string' ? data.token : '',
      publicUrl: typeof data.publicUrl === 'string' ? data.publicUrl : '',
      port: Number.isFinite(data.port) ? data.port : null,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    };
  } catch {
    return { enabled: false, token: '', publicUrl: '', port: null, updatedAt: null };
  }
}

export function saveShare(root, patch) {
  const file = shareFile(root);
  const next = { ...loadShare(root), ...patch, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return next;
}

export const newToken = () => randomBytes(16).toString('hex');

/** 常数时间比较，避免通过响应时间猜密钥 */
export function tokenMatches(expected, provided) {
  if (!expected || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const isLoopback = (req) => {
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};
