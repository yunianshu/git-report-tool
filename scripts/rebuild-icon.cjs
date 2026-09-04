/**
 * build/icon.png + build/icon.ico 清理重建工具
 *
 * 背景：两个图标源自一张带滚动条的窗口截图，右缘带（x≥984）与底缘带（y≥984）
 * 各烙有约 1.8 万个灰色滚动条像素（原图四角本身透明、主体完好）。
 * 本脚本将两条边缘带整体置为透明，其余像素原样保留，并重编：
 *   - build/icon.png（1024×1024 RGBA）
 *   - build/icon.ico（256/128/64/48/32/24/16 PNG 条目）
 *
 * 用法：node scripts/rebuild-icon.cjs [输入png，默认 build/icon.png]
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ─── PNG 解码（filter 0-4） ───
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let off = 8, w = 0, h = 0, colorType = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.slice(off + 8, off + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9] }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const chs = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const bpp = chs, stride = w * bpp
  const out = Buffer.alloc(h * stride)
  let pos = 0
  for (let y = 0; y < h; y++) {
    const f = raw[pos++]
    const row = raw.slice(pos, pos + stride); pos += stride
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    const cur = out.slice(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0
      let v = row[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc) ? b : c
      }
      cur[x] = v & 0xff
    }
  }
  return { w, h, chs, data: out }
}

// ─── PNG 编码（RGBA，全行 Paeth 滤波） ───
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return (pa <= pb && pa <= pc) ? a : (pb <= pc) ? b : c
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

function encodePNG(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 4
    for (let x = 0; x < stride; x++) {
      const cur = x >= 4 ? rgba[y * stride + x - 4] : 0
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0
      const ul = y > 0 && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0
      raw[y * (stride + 1) + 1 + x] = (rgba[y * stride + x] - paeth(cur, up, ul)) & 0xff
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const body = Buffer.alloc(4)
    body.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0)
    return Buffer.concat([head, data, body])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ─── 盒式降采样（按 alpha 加权） ───
function downsample(img, size) {
  const { w, h, data } = img
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx0 = (x * w) / size, sy0 = (y * h) / size
      const sx1 = ((x + 1) * w) / size, sy1 = ((y + 1) * h) / size
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = Math.floor(sy0); sy < Math.min(sy1, h); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.min(sx1, w); sx++) {
          const i = (sy * w + sx) * 4
          const pa = data[i + 3]
          r += data[i] * pa; g += data[i + 1] * pa; b += data[i + 2] * pa; a += pa
          n++
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round(a / n)
      }
    }
  }
  return out
}

// ─── ICO 封装（PNG 条目） ───
function buildIco(images) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4)
  const entries = []
  const blobs = []
  let offset = 6 + images.length * 16
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12)
    entries.push(e)
    blobs.push(png)
    offset += png.length
  }
  return Buffer.concat([dir, ...entries, ...blobs])
}

// ─── 主流程：边缘条纹清理 ───
const inputPath = process.argv[2] || path.join(__dirname, '..', 'build', 'icon.png')
const outDir = path.dirname(inputPath)
const img = decodePNG(fs.readFileSync(inputPath))
const { w, h, chs, data } = img

// 主体边界：以青色像素为准（图形/阴影都在主体矩形内部；条纹与其箭头深色像素均在主体之外）
const isBodyColor = (r, g, b) => g > 90 && r < g - 30 && b < g - 10 && g < 210
let bodyX = 0, bodyY = 0
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * chs
    if (isBodyColor(data[i], data[i + 1], data[i + 2])) {
      if (x > bodyX) bodyX = x
      if (y > bodyY) bodyY = y
    }
  }
}
console.log(`主体右边界 x=${bodyX}，下边界 y=${bodyY}（画布 ${w}×${h}）`)

const out = Buffer.alloc(w * h * 4)
let cleared = 0
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * chs
    const o = (y * w + x) * 4
    if (chs === 4) { out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = data[i + 3] }
    else { out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = 255 }
    if (x > bodyX || y > bodyY) {
      out[o + 3] = 0
      cleared++
    }
  }
}
console.log(`已清理边缘带像素 ${cleared} 个（x>${bodyX} 或 y>${bodyY} 置透明）`)

fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(w, h, out))
console.log(`已重写 build/icon.png（${w}×${h}）`)

const clean = { w, h, data: out }
const sizes = [256, 128, 64, 48, 32, 24, 16]
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(sizes.map((s) => ({ size: s, png: encodePNG(s, s, downsample(clean, s)) }))))
console.log(`已重写 build/icon.ico（${sizes.join('/')} 共 ${sizes.length} 个尺寸）`)
