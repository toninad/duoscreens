// Minimal RGB (no alpha) PNG encoder.
// App Store Connect rejects screenshots with an alpha channel. Browsers' canvas.toBlob('image/png')
// writes RGBA, so we encode color type 2 (truecolor, 8-bit) ourselves using the native zlib
// CompressionStream('deflate'). Falls back to canvas.toBlob if CompressionStream is unavailable.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff;
  dv.setUint32(8 + data.length, crc >>> 0);
  return out;
}

async function zlib(raw) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([raw]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @param {HTMLCanvasElement} canvas @returns {Promise<Blob>} opaque RGB PNG */
export async function canvasToRgbPng(canvas) {
  if (typeof CompressionStream === 'undefined') {
    return new Promise(res => canvas.toBlob(res, 'image/png'));
  }
  const { width: w, height: h } = canvas;
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const stride = w * 3;
  const raw = new Uint8Array((stride + 1) * h);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    let si = y * w * 4;
    for (let x = 0; x < stride; x += 3, si += 4) {
      // Composite over white in case anything is semi-transparent (shouldn't be: background is opaque).
      const a = rgba[si + 3] / 255;
      cur[x] = Math.round(rgba[si] * a + 255 * (1 - a));
      cur[x + 1] = Math.round(rgba[si + 1] * a + 255 * (1 - a));
      cur[x + 2] = Math.round(rgba[si + 2] * a + 255 * (1 - a));
    }
    const o = y * (stride + 1);
    raw[o] = 2; // filter: Up
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (cur[i] - prev[i]) & 0xff;
    prev.set(cur);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = await zlib(raw);
  return new Blob([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())], { type: 'image/png' });
}
