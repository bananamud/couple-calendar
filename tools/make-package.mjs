/**
 * 打包一个「只含软件、不含个人数据」的 zip，方便发给朋友。
 * 自己写 zip：条目路径用正斜杠、文件名用 UTF-8，Mac/Linux 解压也不会乱。
 *
 * 用法： node tools/make-package.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = '情侣日历';

// 不进包的目录 / 文件
// docs/ 里是中性示例的界面预览（README 会引用），一起打包
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.runtime', '.shots', '.tmp', '.chrome-profile', 'bin', '分发包']);
const EXCLUDE_FILES = new Set(['store.json', 'share.json', 'server.log', 'server.err.log', '.DS_Store']);
const EXCLUDE_EXT = ['.log', '.tmp'];

function shouldSkip(rel, name, isDir) {
  if (isDir) return EXCLUDE_DIRS.has(name);
  if (EXCLUDE_FILES.has(name)) return true;
  if (EXCLUDE_EXT.some((ext) => name.endsWith(ext))) return true;
  // data/ 下只有 raw（官方节假日数据）属于软件，其余是个人数据
  if (rel.startsWith('data/') && !rel.startsWith('data/raw/')) return true;
  return false;
}

function collect(dir, out = [], skipped = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).replace(/\\/g, '/');
    if (shouldSkip(rel, entry.name, entry.isDirectory())) {
      skipped.push(entry.isDirectory() ? `${rel}/（整个目录）` : rel);
      continue;
    }
    if (entry.isDirectory()) collect(full, out, skipped);
    else out.push({ full, rel });
  }
  return { files: out, skipped };
}

/* ------------------------------ ZIP 写入 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 把 Date 转成 zip 的 DOS 时间 */
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function makeZip(entries, outFile) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosTime(new Date());

  for (const entry of entries) {
    const data = entry.data;
    const compressed = deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const body = useDeflate ? compressed : data;
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 需要 2.0 版本
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, end]));
}

/* ------------------------------- 主流程 ------------------------------- */

const { files, skipped } = collect(root);
const entries = files.map((f) => ({ name: `${APP_NAME}/${f.rel}`, data: readFileSync(f.full) }));

// 附一份说明，朋友拿到就知道怎么用
const readme = [
  `${APP_NAME} · 分发包`,
  '',
  '这个压缩包里只有软件本身，没有任何人的日历数据。',
  '',
  '用法一（最简单，两台手机在同一个 Wi-Fi）：',
  '  1. 双击「启动情侣日历.bat」，浏览器会打开 http://localhost:5178',
  '  2. 手机连同一个 Wi-Fi，用窗口里显示的 192.168.x.x 地址访问',
  '',
  '用法二（异地也能用）：',
  '  双击「启动并分享给外网.bat」，会生成一条带密钥的配对链接，发给对方即可',
  '',
  '用法三（电脑可以关机）：见 README.md 的「部署到云端（Cloudflare Workers）」。',
  '',
  '第一次运行会自动下载便携版 Node.js（约 36MB），不需要手动安装任何东西。',
].join('\r\n');
entries.push({ name: `${APP_NAME}/请先读我.txt`, data: Buffer.from(readme, 'utf8') });

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outFile = join(root, '分发包', `${APP_NAME}-分发包-${stamp}.zip`);
rmSync(outFile, { force: true });
makeZip(entries, outFile);

const size = Math.round(statSync(outFile).size / 1024);
console.log('');
console.log(`  已打包：分发包/${APP_NAME}-分发包-${stamp}.zip  （${entries.length} 个文件，${size} KB）`);
console.log('');
if (skipped.length) {
  console.log('  已排除（不会发给别人）：');
  for (const item of skipped.slice(0, 12)) console.log(`    · ${item}`);
  if (skipped.length > 12) console.log(`    · …还有 ${skipped.length - 12} 项`);
} else {
  console.log('  没有需要排除的个人数据。');
}
console.log('');
console.log('  自检：压缩包里不应该有 data/store.json（你们的日历数据）。');
