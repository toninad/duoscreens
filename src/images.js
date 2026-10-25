// Captures, ready to keep: scaled to at most the largest size any export draws them at, re-encoded
// as WebP (JPEG where the browser can't make WebP), and named by the SHA-256 of the result. The
// same picture is stored once however often it's used, and a hash never changes meaning.
import { images as stored } from './store.js';

const MAX_SIDE = 2868;          // the tallest App Store size we export (6.9″ iPhone, 1320 × 2868)
const QUALITY = 0.9;            // visually lossless once the capture is framed and exported

const hashes = new WeakMap();   // <img> -> hash
const byHash = new Map();       // hash -> Promise<img>, so each picture is decoded once
const blobs = new Map();        // hash -> its file, while this page has it open

export const hashOf = (img) => (img && hashes.get(img)) || null;

export async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function imgFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = URL.createObjectURL(blob);
  });
}

const toBlob = (canvas, type, q) => new Promise(r => canvas.toBlob(r, type, q));

async function encode(source) {
  const w0 = source.naturalWidth || source.width, h0 = source.naturalHeight || source.height;
  if (!w0 || !h0) throw new Error('That image is empty.');
  const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(source, 0, 0, c.width, c.height);
  let blob = await toBlob(c, 'image/webp', QUALITY);
  if (!blob || blob.type !== 'image/webp') {   // e.g. Safari: no WebP encoder, so a careful JPEG
    x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    blob = await toBlob(c, 'image/jpeg', 0.92);
  }
  if (!blob) throw new Error('Could not process that image.');
  return blob;
}

/** Remembers a stored file under its hash and returns its <img>. */
async function adopt(hash, blob, save) {
  blobs.set(hash, blob);
  if (!byHash.has(hash)) {
    byHash.set(hash, imgFromBlob(blob).then(img => { hashes.set(img, hash); return img; }));
    byHash.get(hash).catch(() => byHash.delete(hash));
  }
  if (save) await stored.put(hash, blob).catch(e => { throw storageError(e); });
  return byHash.get(hash);
}

function storageError(e) {
  const full = e?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '');
  const err = new Error(full ? 'The browser’s storage is full, so this image couldn’t be saved.' : 'This image couldn’t be saved in the browser.');
  err.storage = true;
  return err;
}

/**
 * A file or an <img> -> { img, hash }: compressed, stored locally (when `save`), and the <img> to show.
 * Images that already have a hash are passed through.
 */
export async function prepareImage(source, { save = true } = {}) {
  if (hashOf(source)) {
    const h = hashOf(source);
    if (save && blobs.has(h) && !(await stored.has(h).catch(() => true))) await stored.put(h, blobs.get(h)).catch(e => { throw storageError(e); });
    return { img: source, hash: hashOf(source) };
  }
  let decoded = source;
  if (source instanceof Blob) decoded = await imgFromBlob(source);
  const blob = await encode(decoded);
  if (source instanceof Blob) URL.revokeObjectURL(decoded.src);
  const hash = await sha256Hex(await blob.arrayBuffer());
  return { img: await adopt(hash, blob, save), hash };
}

/** The <img> for a stored hash, or null if this browser doesn't have it (yet). */
export async function imageFromHash(hash) {
  if (byHash.has(hash)) return byHash.get(hash).catch(() => null);
  const rec = await stored.get(hash).catch(() => null);
  if (!rec) return null;
  return adopt(hash, rec.blob, false).catch(() => null);
}

/** Stores a file that arrived from elsewhere (a backup or sync) after checking it matches its hash. */
export async function storeVerified(hash, blob) {
  if (await sha256Hex(await blob.arrayBuffer()) !== hash) throw new Error('An image was damaged on the way.');
  await stored.put(hash, blob).catch(e => { throw storageError(e); });
}

export async function blobForHash(hash) {
  return blobs.get(hash) || (await stored.get(hash).catch(() => null))?.blob || null;
}
