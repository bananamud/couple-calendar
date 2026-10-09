/**
 * 生成 App 图标（纯 Node 内置模块手写 PNG，无需图形库）。
 * 用法： node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');

/* ------------------------------ PNG 编码 ------------------------------ */
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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- 绘制 ------------------------------- */

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 圆角矩形的覆盖率（超采样由调用方做）
function roundedCoverage(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const d = Math.hypot(x - cx, y - cy);
  return clamp01(radius + 0.5 - d);
}

/** 心形隐函数：(x²+y²-1)³ - x²y³ <= 0 */
function inHeart(nx, ny) {
  const a = nx * nx + ny * ny - 1;
  return a * a * a - nx * nx * ny * ny * ny <= 0;
}

function renderIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3; // 超采样
  const radius = maskable ? 0 : size * 0.24;
  // 心形隐函数横向半宽约 1.36 个单位的归一化空间
  const heartScale = size * (maskable ? 0.175 : 0.205);
  const cx = size / 2;
  const cy = size * (maskable ? 0.45 : 0.46);

  const c1 = [127, 178, 245]; // 蓝
  const c2 = [255, 168, 198]; // 粉
  const heartColor = [255, 255, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          const bgAlpha = maskable ? 1 : roundedCoverage(px, py, size, radius);
          const t = clamp01((px / size) * 0.45 + (py / size) * 0.55);
          let color = mix(c1, c2, t);

          // 心形（y 轴翻转）
          const hx = (px - cx) / heartScale;
          const hy = (cy - py) / heartScale;
          if (inHeart(hx * 0.92, hy * 0.92)) color = heartColor;

          r += color[0];
          g += color[1];
          b += color[2];
          a += bgAlpha * 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
const targets = [
  ['icon-180.png', 180, {}],
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, opts] of targets) {
  const png = renderIcon(size, opts);
  writeFileSync(join(outDir, name), png);
  console.log(`已生成 icons/${name} (${size}×${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}
