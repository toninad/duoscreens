// Pro sync: /api/sync/<action>. Boards and images are end-to-end encrypted in the browser, so this
// only stores ciphertext: board records in D1 (sync_boards), images in R2 under <key hash>/<image id>.
// Every call carries the license key and device id in headers and is checked like /api/license.
//
//   list                 {}                                         -> { boards: [{ id, version, deleted, updatedAt }], usage, wipedAt }
//   get                  { id }                                     -> { id, version, deleted, data }
//   put                  { id, baseVersion, data?, deleted?, images, wipedAt } -> { version, usage } | 409 conflict or wiped | 422 missing images | 413 full
//   has                  { ids }                                    -> { missing }
//   upload?id=<image id> raw bytes                                  -> { ok, usage } | 413 full
//   download             { id }                                     -> raw bytes | 404
//   delete-all           {}                                         -> { ok }
//
// Images are only ever added or removed, never changed: an id is a fingerprint of the content.
// The daily cleanup (cleanupSync below) deletes images no board uses after a grace period.

import { json, originAllowed, rateLimit, readJson } from '../_lib/http.js';
import { verifyLicense, LicenseError } from '../_lib/license.js';

const BOARD_ID = /^[a-zA-Z0-9-]{8,64}$/;
const IMAGE_ID = /^[0-9a-f]{64}$/;
const MAX_BOARD_CHARS = 1_500_000;          // base64 of an encrypted, gzipped board: real ones are a few KB
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;   // compressed captures are ~0.1-0.5 MB
const MAX_IDS = 2000;
const DAY = 24 * 60 * 60 * 1000;

const limits = (env) => ({
  bytes: Number(env.SYNC_BYTES_PER_KEY || 1024 ** 3),
  boards: Number(env.SYNC_MAX_BOARDS || 200),
});

async function usage(env, keyHash) {
  const img = await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS b, COUNT(*) AS n FROM sync_images WHERE key_hash = ?1').bind(keyHash).first();
  const brd = await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS b, COALESCE(SUM(deleted = 0), 0) AS n FROM sync_boards WHERE key_hash = ?1').bind(keyHash).first();
  const l = limits(env);
  return { bytes: Number(img.b) + Number(brd.b), limit: l.bytes, boards: Number(brd.n), maxBoards: l.boards, images: Number(img.n) };
}

const objectKey = (keyHash, id) => `${keyHash}/${id}`;

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return json({ error: 'Forbidden' }, 403);
  if (!env.SYNC || !env.DB) return json({ error: 'Sync is not set up on the server yet.' }, 503);
  if (!(await rateLimit(env, request, 'sync', 600))) return json({ error: 'Too many requests. Wait a minute.' }, 429);

  let keyHash;
  try {
    ({ keyHash } = await verifyLicense(env, request.headers.get('X-License-Key'), request.headers.get('X-Device')));
  } catch (e) {
    if (e instanceof LicenseError) return json({ error: e.message, pro: false }, e.status);
    throw e;
  }

  const url = new URL(request.url);
  const action = url.pathname.replace(/^\/api\/sync\//, '');

  if (action === 'upload') return upload(request, env, keyHash, url.searchParams.get('id'));
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request.' }, 400);

  switch (action) {
    case 'list': return list(env, keyHash);
    case 'get': return get(env, keyHash, body);
    case 'put': return put(env, keyHash, body);
    case 'has': return has(env, keyHash, body);
    case 'download': return download(env, keyHash, body);
    case 'delete-all': await deleteAll(env, keyHash, { remember: true }); return json({ ok: true });
    default: return json({ error: 'Not found' }, 404);
  }
}

async function list(env, keyHash) {
  const { results } = await env.DB.prepare('SELECT id, version, deleted, updated_at FROM sync_boards WHERE key_hash = ?1').bind(keyHash).all();
  const wiped = await env.DB.prepare('SELECT wiped_at FROM sync_keys WHERE key_hash = ?1').bind(keyHash).first();
  return json({
    wipedAt: wiped ? Number(wiped.wiped_at) : 0,
    boards: results.map(r => ({ id: r.id, version: Number(r.version), deleted: !!r.deleted, updatedAt: Number(r.updated_at) })),
    usage: await usage(env, keyHash),
  });
}

async function get(env, keyHash, { id }) {
  if (!BOARD_ID.test(id || '')) return json({ error: 'Invalid board id.' }, 400);
  const r = await env.DB.prepare('SELECT id, version, deleted, data, updated_at FROM sync_boards WHERE key_hash = ?1 AND id = ?2').bind(keyHash, id).first();
  if (!r) return json({ error: 'Not found' }, 404);
  return json({ id: r.id, version: Number(r.version), deleted: !!r.deleted, data: r.data, updatedAt: Number(r.updated_at) });
}

const validIds = (ids) => Array.isArray(ids) && ids.length <= MAX_IDS && ids.every(i => typeof i === 'string' && IMAGE_ID.test(i));

async function missingImages(env, keyHash, ids) {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT value AS id FROM json_each(?2) WHERE value NOT IN (SELECT id FROM sync_images WHERE key_hash = ?1)',
  ).bind(keyHash, JSON.stringify(ids)).all();
  return results.map(r => r.id);
}

async function has(env, keyHash, { ids }) {
  if (!validIds(ids)) return json({ error: 'Invalid image ids.' }, 400);
  return json({ missing: await missingImages(env, keyHash, ids) });
}

async function put(env, keyHash, body) {
  const { id, baseVersion, data, deleted = false, images = [], wipedAt = 0 } = body;
  if (!BOARD_ID.test(id || '')) return json({ error: 'Invalid board id.' }, 400);
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return json({ error: 'Invalid version.' }, 400);
  if (!deleted) {
    if (typeof data === 'string' && data.length > MAX_BOARD_CHARS) return json({ error: 'This board is too large to sync.' }, 413);
    if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) return json({ error: 'Invalid board data.' }, 400);
  }
  if (!validIds(images)) return json({ error: 'Invalid image ids.' }, 400);
  const refs = deleted ? [] : [...new Set(images)];
  // A browser that hasn't seen the latest "Delete synced data" must not upload its boards again.
  const wiped = await env.DB.prepare('SELECT wiped_at FROM sync_keys WHERE key_hash = ?1').bind(keyHash).first();
  if ((wiped ? Number(wiped.wiped_at) : 0) !== Number(wipedAt || 0)) return json({ error: 'wiped', wipedAt: wiped ? Number(wiped.wiped_at) : 0 }, 409);

  // Images first: a board may only point at images the server has, so another browser never
  // downloads a board it can't show.
  const missing = await missingImages(env, keyHash, refs);
  if (missing.length) return json({ error: 'Upload these images first.', missing }, 422);

  const current = await env.DB.prepare('SELECT version, bytes, deleted FROM sync_boards WHERE key_hash = ?1 AND id = ?2').bind(keyHash, id).first();
  if ((current ? Number(current.version) : 0) !== baseVersion) {
    return json({ error: 'conflict', version: current ? Number(current.version) : 0 }, 409);
  }
  const bytes = deleted ? 0 : data.length;
  if (!deleted) {
    const u = await usage(env, keyHash);
    const growing = !current || current.deleted;
    if (growing && u.boards >= u.maxBoards) return json({ error: `Sync holds up to ${u.maxBoards} boards. Delete some to sync more.`, usage: u }, 413);
    if (u.bytes - (current ? Number(current.bytes) : 0) + bytes > u.limit) return json({ error: 'Sync storage is full. Delete boards or images you no longer need.', usage: u }, 413);
  }

  const now = Date.now();
  const version = baseVersion + 1;
  // Compare-and-set on the version, so two browsers writing at once can't overwrite each other.
  const res = current
    ? await env.DB.prepare('UPDATE sync_boards SET version = ?3, deleted = ?4, data = ?5, bytes = ?6, updated_at = ?7 WHERE key_hash = ?1 AND id = ?2 AND version = ?8')
      .bind(keyHash, id, version, deleted ? 1 : 0, deleted ? null : data, bytes, now, baseVersion).run()
    : await env.DB.prepare('INSERT INTO sync_boards (key_hash, id, version, deleted, data, bytes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(key_hash, id) DO NOTHING')
      .bind(keyHash, id, version, deleted ? 1 : 0, deleted ? null : data, bytes, now).run();
  if (!res.meta?.changes) {
    const again = await env.DB.prepare('SELECT version FROM sync_boards WHERE key_hash = ?1 AND id = ?2').bind(keyHash, id).first();
    return json({ error: 'conflict', version: again ? Number(again.version) : 0 }, 409);
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM sync_refs WHERE key_hash = ?1 AND board_id = ?2').bind(keyHash, id),
    env.DB.prepare('INSERT OR IGNORE INTO sync_refs (key_hash, board_id, image_id) SELECT ?1, ?2, value FROM json_each(?3)').bind(keyHash, id, JSON.stringify(refs)),
    env.DB.prepare('UPDATE sync_images SET orphan_since = NULL WHERE key_hash = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(keyHash, JSON.stringify(refs)),
  ]);
  return json({ version, usage: await usage(env, keyHash) });
}

async function upload(request, env, keyHash, id) {
  if (!IMAGE_ID.test(id || '')) return json({ error: 'Invalid image id.' }, 400);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_IMAGE_BYTES) return json({ error: 'Image is too large.' }, 413);
  const exists = await env.DB.prepare('SELECT 1 FROM sync_images WHERE key_hash = ?1 AND id = ?2').bind(keyHash, id).first();
  if (exists) { await request.arrayBuffer().catch(() => {}); return json({ ok: true }); }
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: 'Empty image.' }, 400);
  if (buf.byteLength > MAX_IMAGE_BYTES) return json({ error: 'Image is too large.' }, 413);
  const u = await usage(env, keyHash);
  if (u.bytes + buf.byteLength > u.limit) return json({ error: 'Sync storage is full. Delete boards or images you no longer need.', usage: u }, 413);
  await env.SYNC.put(objectKey(keyHash, id), buf);
  await env.DB.prepare('INSERT OR IGNORE INTO sync_images (key_hash, id, bytes, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(keyHash, id, buf.byteLength, Date.now()).run();
  return json({ ok: true, usage: await usage(env, keyHash) });
}

async function download(env, keyHash, { id }) {
  if (!IMAGE_ID.test(id || '')) return json({ error: 'Invalid image id.' }, 400);
  const row = await env.DB.prepare('SELECT 1 FROM sync_images WHERE key_hash = ?1 AND id = ?2').bind(keyHash, id).first();
  const obj = row && await env.SYNC.get(objectKey(keyHash, id));
  if (!obj) return json({ error: 'Not found' }, 404);
  return new Response(obj.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
}

async function deleteObjects(env, keys) {
  for (let i = 0; i < keys.length; i += 1000) await env.SYNC.delete(keys.slice(i, i + 1000));
}

/** Everything synced for one license key, now. `remember` tells the key's other browsers it happened. */
export async function deleteAll(env, keyHash, { remember = false } = {}) {
  // Always list from the start: each round deletes what it found, so a cursor would skip objects.
  for (let round = 0; round < 10_000; round++) {
    const page = await env.SYNC.list({ prefix: `${keyHash}/` });
    if (!page.objects.length) break;
    await deleteObjects(env, page.objects.map(o => o.key));
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sync_refs WHERE key_hash = ?1').bind(keyHash),
    env.DB.prepare('DELETE FROM sync_images WHERE key_hash = ?1').bind(keyHash),
    env.DB.prepare('DELETE FROM sync_boards WHERE key_hash = ?1').bind(keyHash),
    remember
      ? env.DB.prepare('INSERT OR REPLACE INTO sync_keys (key_hash, wiped_at) VALUES (?1, ?2)').bind(keyHash, Date.now())
      : env.DB.prepare('DELETE FROM sync_keys WHERE key_hash = ?1').bind(keyHash),
  ]);
}

/**
 * Daily cleanup (Worker cron): marks images no board uses, deletes those unused for 7 days, drops
 * deletion markers after 90 days, and removes all synced data of keys revoked over 30 days ago.
 */
export async function cleanupSync(env, now = Date.now()) {
  if (!env.DB || !env.SYNC) return { skipped: true };
  await env.DB.prepare(
    `UPDATE sync_images SET orphan_since = ?1 WHERE orphan_since IS NULL AND NOT EXISTS
       (SELECT 1 FROM sync_refs r WHERE r.key_hash = sync_images.key_hash AND r.image_id = sync_images.id)`,
  ).bind(now).run();
  let removed = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT key_hash, id FROM sync_images WHERE orphan_since IS NOT NULL AND orphan_since < ?1 AND NOT EXISTS
         (SELECT 1 FROM sync_refs r WHERE r.key_hash = sync_images.key_hash AND r.image_id = sync_images.id) LIMIT 500`,
    ).bind(now - 7 * DAY).all();
    if (!results.length) break;
    await deleteObjects(env, results.map(r => objectKey(r.key_hash, r.id)));
    await env.DB.batch(results.map(r => env.DB.prepare('DELETE FROM sync_images WHERE key_hash = ?1 AND id = ?2').bind(r.key_hash, r.id)));
    removed += results.length;
    if (results.length < 500) break;
  }
  await env.DB.prepare('DELETE FROM sync_boards WHERE deleted = 1 AND updated_at < ?1').bind(now - 90 * DAY).run();
  const { results: gone } = await env.DB.prepare(
    `SELECT DISTINCT b.key_hash FROM sync_boards b JOIN licenses l ON l.key_hash = b.key_hash
     WHERE l.status != 'granted' AND l.checked_at < ?1
     UNION SELECT DISTINCT i.key_hash FROM sync_images i JOIN licenses l ON l.key_hash = i.key_hash
     WHERE l.status != 'granted' AND l.checked_at < ?1`,
  ).bind(now - 30 * DAY).all();
  for (const { key_hash } of gone) await deleteAll(env, key_hash);
  return { removed, revoked: gone.length };
}
