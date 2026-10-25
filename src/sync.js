// Pro sync: copies saved boards and their images to the server, end-to-end encrypted, and brings
// other browsers' changes back. The browser encrypts everything with keys derived from the license
// key; the server only ever sees ciphertext, sizes and versions (see functions/api/sync.js).
//
// Each local board record has `remoteVersion` (the server version it last matched) and `dirty`
// (changed here since). A round: list the server's boards, pull what changed elsewhere, then push
// what changed here. A write names the version it started from; if another browser got there
// first, both versions are kept: the other one arrives as "… (from another browser)".
import { SYNC_ENDPOINT } from './config.js';
import { boards, images as stored, meta, imageHashesOf } from './store.js';
import { blobForHash, storeVerified } from './images.js';
import { deviceId } from './license.js';

const enc = (s) => new TextEncoder().encode(s);
const b64 = (buf) => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

// ---------- Encryption ----------
// License keys are long random strings, so HKDF (not a slow password hash) is the right tool.
async function deriveKeys(licenseKey) {
  const base = await crypto.subtle.importKey('raw', enc(licenseKey.trim()), 'HKDF', false, ['deriveKey']);
  const salt = enc('hhstudio-sync-v1');
  const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc('boards and images') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const mac = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc('image ids') }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  return { aes, mac, ids: new Map() };
}

async function seal(keys, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.aes, bytes);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv); out.set(new Uint8Array(ct), 12);
  return out;
}
async function open(keys, bytes) {
  bytes = new Uint8Array(bytes);
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, keys.aes, bytes.subarray(12))); }
  catch { throw new Error('A synced item couldn’t be decrypted.'); }
}

// Boards: [format byte][gzip(JSON)] (format 0 = plain JSON where the browser can't gzip).
async function packBoard(keys, payload) {
  const json = enc(JSON.stringify(payload));
  let body = json, format = 0;
  if (typeof CompressionStream === 'function') {
    body = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    format = 1;
  }
  const plain = new Uint8Array(body.length + 1);
  plain[0] = format; plain.set(body, 1);
  return b64(await seal(keys, plain));
}
async function unpackBoard(keys, data) {
  const plain = await open(keys, unb64(data));
  let body = plain.subarray(1);
  if (plain[0] === 1) body = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  else if (plain[0] !== 0) throw new Error('A synced board is in a newer format. Reload the page.');
  return JSON.parse(new TextDecoder().decode(body));
}

/** The server's name for an image: an HMAC of its content hash, so ids can't be linked to pictures. */
async function remoteId(keys, hash) {
  if (!keys.ids.has(hash)) keys.ids.set(hash, hex(await crypto.subtle.sign('HMAC', keys.mac, enc(hash))));
  return keys.ids.get(hash);
}

const sniffType = (b) => (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 ? 'image/webp'
  : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : 'application/octet-stream');

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}

class SyncError extends Error {
  constructor(message, { status = 0, stop = false } = {}) { super(message); this.status = status; this.stop = stop; }
}

/**
 * @param {object} app
 *   licenseKey(): string           the Pro key ('' when not Pro)
 *   isBusy(id): boolean            unsaved edits to that board in this tab: don't replace it yet
 *   flush(): Promise               saves pending edits now
 *   boardChanged(id, how)          a board was added, changed or removed by sync ('changed' | 'added' | 'removed')
 *   status(s)                      { state: 'off'|'syncing'|'synced'|'offline'|'error', message?, at?, usage? }
 */
export function createSync(app) {
  const skipped = new Set();
  let epoch = 0;   // the server's "data deleted at" this round saw; writes carry it
  let enabled = false, keys = null, keyFor = '', running = null, again = false, timer = null, lastStatus = { state: 'off' };

  const report = (s) => { lastStatus = s; app.status(s); };

  async function api(action, body, { raw, query = '' } = {}) {
    let res;
    try {
      res = await fetch(`${SYNC_ENDPOINT}/${action}${query}`, {
        method: 'POST',
        headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-License-Key': app.licenseKey(), 'X-Device': deviceId() },
        body: raw ?? JSON.stringify(body || {}),
      });
    } catch {
      throw new SyncError('Offline. Changes will sync when you’re back online.', { status: 0 });
    }
    const type = res.headers.get('content-type') || '';
    if (res.ok && !type.includes('json')) return new Uint8Array(await res.arrayBuffer());
    let data = {};
    try { data = await res.json(); } catch { if (!res.ok) throw new SyncError('Sync isn’t available on this deployment.', { status: res.status, stop: true }); }
    if (res.ok || res.status === 409 || res.status === 422) return Object.assign(data, { status: res.status });
    if (data.pro === false) throw new SyncError(`Sync stopped: ${data.error || 'license not active.'}`, { status: res.status, stop: true });
    if (res.status === 413) throw new SyncError(data.error || 'Sync storage is full.', { status: 413, stop: true });
    throw new SyncError(data.error || `Sync failed (${res.status}).`, { status: res.status });
  }

  async function ensureKeys() {
    const k = app.licenseKey();
    if (!k) throw new SyncError('Sync needs Pro.', { stop: true });
    if (k !== keyFor) { keys = await deriveKeys(k); keyFor = k; }
    return keys;
  }

  // ---------- Pull ----------
  async function downloadImages(doc) {
    let missing = 0;
    await pool(imageHashesOf(doc), 4, async (hash) => {
      if (await stored.has(hash)) return;
      const r = await api('download', { id: await remoteId(keys, hash) }).catch(e => { if (e.status === 404) return null; throw e; });
      if (!(r instanceof Uint8Array)) { missing++; return; }
      const bytes = await open(keys, r);
      await storeVerified(hash, new Blob([bytes], { type: sniffType(bytes) }));
    });
    return missing;
  }

  async function pull(remote, { asCopy = false, base = null } = {}) {
    const g = await api('get', { id: remote.id });
    if (g.status !== 200 || g.deleted || !g.data) return;
    const payload = await unpackBoard(keys, g.data);
    if (!payload?.doc) throw new SyncError('A synced board was unreadable.');
    await downloadImages(payload.doc);
    const now = Date.now();
    if (asCopy) {
      const id = crypto.randomUUID();
      await boards.put({ id, name: `${payload.name || 'Untitled board'} (from another browser)`, doc: payload.doc, createdAt: now, updatedAt: now, remoteVersion: 0, dirty: true, deleted: false });
      app.boardChanged(id, 'added');
      return;
    }
    let applied = false;
    await boards.update(remote.id, (cur) => {
      // Edited here while we were downloading: keep the edit; the next round sees the conflict.
      if (cur && base && (cur.updatedAt !== base.updatedAt || (cur.dirty && !base.dirty))) return null;
      applied = true;
      return { id: remote.id, name: payload.name || 'Untitled board', doc: payload.doc, createdAt: payload.createdAt || now, updatedAt: remote.updatedAt || now, remoteVersion: g.version, dirty: false, deleted: false };
    });
    if (applied) app.boardChanged(remote.id, base ? 'changed' : 'added');
  }

  // ---------- Push ----------
  async function push(rec) {
    if (rec.deleted) {
      if (!rec.remoteVersion) { await boards.delete(rec.id); return; }
      const r = await api('put', { id: rec.id, baseVersion: rec.remoteVersion, deleted: true, wipedAt: epoch });
      if (r.status === 200) await boards.delete(rec.id);
      return r.status === 409;
    }
    const hashes = imageHashesOf(rec.doc);
    const ids = await Promise.all(hashes.map(h => remoteId(keys, h)));
    const send = async () => {
      const { missing } = await api('has', { ids });
      const want = new Set(missing);
      await pool(hashes.filter((h, i) => want.has(ids[i])), 3, async (hash) => {
        const blob = await blobForHash(hash);
        if (!blob) return;   // not in this browser (never downloaded): the board waits until it is
        const sealed = await seal(keys, new Uint8Array(await blob.arrayBuffer()));
        await api('upload', null, { raw: sealed, query: `?id=${await remoteId(keys, hash)}` });
      });
      const data = await packBoard(keys, { name: rec.name, doc: rec.doc, createdAt: rec.createdAt });
      return api('put', { id: rec.id, baseVersion: rec.remoteVersion, data, images: ids, wipedAt: epoch });
    };
    let r = await send();
    if (r.status === 422) r = await send();   // an image went missing in between (cleanup): upload and retry once
    if (r.status === 422) { skipped.add(rec.id); return false; }   // its images aren't all here yet; the others still sync
    if (r.status === 409) return true;
    await boards.update(rec.id, (cur) => cur && {
      ...cur, remoteVersion: r.version,
      dirty: cur.updatedAt !== rec.updatedAt || cur.name !== rec.name,   // edited again while uploading: stays dirty
    });
    return false;
  }

  // ---------- A round ----------
  async function round() {
    await ensureKeys();
    await app.flush();
    const startedAt = Date.now();
    const list = await api('list');
    epoch = list.wipedAt || 0;
    const lastOk = Number(await meta.get('syncOkAt') || 0);
    if (list.wipedAt && list.wipedAt > lastOk && lastOk) {
      // "Delete synced data" was used in another browser: don't upload it all again.
      for (const b of await boards.all()) await boards.update(b.id, c => c && ({ ...c, remoteVersion: 0, dirty: true }));
      await setEnabled(false);
      throw new SyncError('Synced data was deleted from another browser, so sync is off here. Your boards are still saved in this browser.', { stop: true });
    }
    const remote = new Map(list.boards.map(b => [b.id, b]));
    let conflict = false;

    for (const r of list.boards) {
      const l = await boards.get(r.id);
      if (!l) { if (!r.deleted) await pull(r); continue; }
      if (r.version <= l.remoteVersion) continue;
      if (r.deleted) {
        if (l.dirty && !l.deleted) await boards.update(r.id, c => c && ({ ...c, remoteVersion: r.version }));   // edited here: bring it back
        else { await boards.delete(r.id); app.boardChanged(r.id, 'removed'); }
      } else if (!l.dirty || l.deleted) {
        if (app.isBusy(r.id)) { again = true; continue; }
        await pull(r, { base: l });
      } else {
        await pull(r, { asCopy: true });   // changed in both places: keep theirs as a copy, ours stays
        await boards.update(r.id, c => c && ({ ...c, remoteVersion: r.version }));
      }
    }
    // Boards this browser synced before that the server no longer has (purged, or a new license
    // key): upload them again rather than lose them.
    for (const l of await boards.all()) {
      if (l.remoteVersion && !remote.has(l.id)) await boards.update(l.id, c => c && ({ ...c, remoteVersion: 0, dirty: true }));
    }
    skipped.clear();
    // Untouched starter boards stay local, so each new browser doesn't add an empty board everywhere.
    for (const l of await boards.all()) if (l.dirty && !(l.pristine && !l.remoteVersion && !l.deleted)) conflict = (await push(l)) || conflict;
    if (conflict) again = true;
    await meta.set('syncOkAt', startedAt);
    return list.usage;
  }

  async function run() {
    if (!enabled || !app.licenseKey()) { if (enabled) report({ state: 'off' }); return; }
    if (running) { again = true; return running; }
    running = (async () => {
      report({ state: 'syncing', usage: lastStatus.usage });
      let usage = lastStatus.usage;
      try {
        for (let i = 0; i < 4; i++) {
          again = false;
          usage = (await round()) || usage;
          if (!again) break;
        }
        if (again) schedule(5000);   // a board was busy being edited, or kept conflicting: try again soon
        report(skipped.size
          ? { state: 'error', message: 'Some boards are waiting for images that aren’t in this browser yet.', usage }
          : { state: 'synced', at: Date.now(), usage });
      } catch (e) {
        console.warn('sync', e);
        if (e.stop && enabled && e.status !== 413) await setEnabled(false, { quiet: true });
        report({ state: e.status === 0 && !e.stop ? 'offline' : 'error', message: e.message, usage });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function schedule(ms = 2500) {
    clearTimeout(timer);
    if (enabled) timer = setTimeout(run, ms);
  }

  async function setEnabled(on, { quiet = false } = {}) {
    enabled = !!on;
    await meta.set('syncEnabled', enabled).catch(() => {});
    if (!enabled) { clearTimeout(timer); if (!quiet) report({ state: 'off' }); }
    else await meta.set('syncOkAt', 0).catch(() => {});
    if (enabled) return run();
  }

  async function init() {
    enabled = !!(await meta.get('syncEnabled').catch(() => false));   // runs once the license is confirmed
    report({ state: 'off' });
    if (enabled) schedule(500);
    setInterval(() => { if (enabled && document.visibilityState === 'visible') run(); }, 60_000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
    addEventListener('online', () => schedule(300));
  }

  /** Deletes everything synced for this key on the server; local boards stay. */
  async function deleteRemote() {
    await ensureKeys();
    await api('delete-all', {});
    for (const b of await boards.all()) {
      if (b.deleted) await boards.delete(b.id);
      else await boards.update(b.id, c => c && ({ ...c, remoteVersion: 0, dirty: true }));
    }
    await setEnabled(false);
  }

  return {
    init, run, schedule, setEnabled, deleteRemote,
    get enabled() { return enabled; },
    get status() { return lastStatus; },
    _test: { deriveKeys, packBoard, unpackBoard },
  };
}
