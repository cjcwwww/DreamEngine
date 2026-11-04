/* ============================================================
 * png.cjs —— 最小 PNG 编解码（8bit RGB/RGBA，非隔行）
 *
 * 为什么需要：L1 打包要判断「某个格子在 6 帧里是否完全一样」，
 * 静态效果的 6 帧内容重复，体积是纯浪费。但 ExtendScript 里没有
 * 图像库，Node 侧也没有内置 PNG 解码——所以自带一个。
 *
 * 只依赖 node:zlib，不引入任何第三方包。
 * ============================================================ */

const fs = require("node:fs");
const zlib = require("node:zlib");

let CRC_TABLE = null;

function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 解码 PNG，返回 {width,height,channels,data} */
function decode(fileOrBuffer) {
  const buf = Buffer.isBuffer(fileOrBuffer)
    ? fileOrBuffer
    : fs.readFileSync(fileOrBuffer);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG 文件");

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`只支持 8bit，got ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`不支持的 colorType ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** 编码 RGB PNG（filter 0，deflate） */
function encode(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunks = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    chunks.push(len, td, crc);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  chunk("IHDR", ihdr);
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 }));
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ...chunks]);
}

/** 取一块矩形区域的原始字节 */
function region(image, x, y, w, h) {
  const ch = image.channels;
  const out = Buffer.alloc(w * h * ch);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * image.width + x) * ch;
    image.data.copy(out, row * w * ch, from, from + w * ch);
  }
  return out;
}

/** 把 src 的一块矩形贴到 dst 的同一位置 */
function blit(dst, src, x, y, w, h) {
  const ch = dst.channels;
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * src.width + x) * ch;
    src.data.copy(dst.data, ((y + row) * dst.width + x) * ch, from, from + w * ch);
  }
}

/** 新建一张空的 RGB 图（黑底） */
function blank(width, height) {
  const rgb = Buffer.alloc(width * height * 3, 0);
  return { width, height, channels: 3, data: rgb };
}

module.exports = { decode, encode, region, blit, blank };
