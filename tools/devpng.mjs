/**
 * 开发用：读取 PNG 并在指定区域采样像素（用来分析截图里的渲染问题）。
 * 用法： node tools/devpng.mjs <png> <x> <y> <w> <h> [step]
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const [, , file, xs, ys, ws, hs, steps] = process.argv;
const x0 = Number(xs);
const y0 = Number(ys);
const w = Number(ws);
const h = Number(hs);
const step = Number(steps ?? 4);

const buf = readFileSync(file);
if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');

let pos = 8;
let width = 0;
let height = 0;
let bitDepth = 0;
let colorType = 0;
const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString('ascii', pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data[8];
    colorType = data[9];
  } else if (type === 'IDAT') {
    idat.push(data);
  } else if (type === 'IEND') break;
  pos += 12 + len;
}
if (bitDepth !== 8) throw new Error(`暂不支持 bitDepth=${bitDepth}`);
const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
if (!channels) throw new Error(`暂不支持 colorType=${colorType}`);

const raw = inflateSync(Buffer.concat(idat));
const stride = width * channels;
const pixels = Buffer.alloc(height * stride);
let rp = 0;
for (let y = 0; y < height; y++) {
  const filter = raw[rp++];
  const row = raw.subarray(rp, rp + stride);
  rp += stride;
  const out = pixels.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
  for (let i = 0; i < stride; i++) {
    const a = i >= channels ? out[i - channels] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= channels ? prev[i - channels] : 0;
    let value = row[i];
    if (filter === 1) value += a;
    else if (filter === 2) value += b;
    else if (filter === 3) value += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i] = value & 0xff;
  }
}

const at = (x, y) => {
  const i = y * stride + x * channels;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
};
const lum = ([r, g, b]) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

console.log(`图片 ${width}x${height}  colorType=${colorType}`);
console.log(`区域 x=${x0} y=${y0} w=${w} h=${h} 采样步长=${step}`);
let header = '     ';
for (let x = x0; x < x0 + w; x += step * 2) header += String(x).padStart(8);
console.log(header);
for (let y = y0; y < y0 + h; y += step) {
  let line = String(y).padStart(4) + ' ';
  for (let x = x0; x < x0 + w; x += step * 2) {
    const px = at(Math.min(x, width - 1), Math.min(y, height - 1));
    line += (lum(px) + hex(px)).padStart(8);
  }
  console.log(line);
}
