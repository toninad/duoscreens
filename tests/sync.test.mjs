// Tests for /api/sync/* and the daily cleanup, without Cloudflare (D1 via node:sqlite, R2 via a Map).
// Run: npm run test:functions
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as sync, cleanupSync } from '../functions/api/sync.js';
import { sha256 } from '../functions/_lib/http.js';
import { fakeD1, fakeR2 } from './fakes.mjs';

const ORIGIN = 'https://studio.hearhere.media';
const KEY = 'POLAR-SYNC-KEY-0001', OTHER = 'POLAR-SYNC-KEY-0002';
const DEVICE = 'device-aaaaaaaa-0001';
const DAY = 24 * 60 * 60 * 1000;
const img = (n) => n.toString(16).padStart(64, '0');
let env;

async function license(key, status = 'granted', checkedAt = Date.now()) {
  const h = await sha256(key);
  env.DB.raw.prepare('INSERT OR REPLACE INTO licenses (key_hash, status, checked_at) VALUES (?, ?, ?)').run(h, status, checkedAt);
  env.DB.raw.prepare('INSERT OR REPLACE INTO activations (key_hash, device, activation_id, created_at) VALUES (?, ?, ?, ?)').run(h, DEVICE, 'act_1', Date.now());
  return h;
}

beforeEach(async () => {
  env = { DB: fakeD1(), SYNC: fakeR2(), POLAR_ACCESS_TOKEN: 'polar_oat_test', POLAR_ORGANIZATION_ID: 'org_test', ALLOWED_ORIGIN: ORIGIN };
  // Polar is never reached for cached keys; anything else is "not found".
  globalThis.fetch = async () => Response.json({ detail: 'Not found' }, { status: 404 });
  await license(KEY); await license(OTHER);
});

async function call(action, body, { key = KEY, raw, origin = ORIGIN, query = '' } = {}) {
  const r = await sync({
    env,
    request: new Request(`${ORIGIN}/api/sync/${action}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', Origin: origin, 'CF-Connecting-IP': '1.2.3.4', 'X-License-Key': key, 'X-Device': DEVICE },
      body: raw ?? JSON.stringify(body ?? {}),
    }),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
}
const upload = (id, bytes = new Uint8Array([1, 2, 3, 4]), opts) => call('upload', null, { raw: bytes, query: `?id=${id}`, ...opts });
const board = (id, baseVersion, images = [], data = 'Y2lwaGVydGV4dA==') => call('put', { id, baseVersion, data, images });

test('a board can only point at images the server already has', async () => {
  const r = await board('board-0001', 0, [img(1), img(2)]);
  assert.equal(r.status, 422);
  assert.deepEqual(r.body.missing.sort(), [img(1), img(2)]);
  assert.equal((await call('has', { ids: [img(1), img(2)] })).body.missing.length, 2);
  await upload(img(1));
  assert.deepEqual((await call('has', { ids: [img(1), img(2)] })).body.missing, [img(2)]);
  await upload(img(2));
  const ok = await board('board-0001', 0, [img(1), img(2)]);
  assert.equal(ok.status, 200); assert.equal(ok.body.version, 1);
  const got = await call('get', { id: 'board-0001' });
  assert.equal(got.body.data, 'Y2lwaGVydGV4dA=='); assert.equal(got.body.version, 1);
  const l = await call('list');
  assert.deepEqual(l.body.boards.map(b => [b.id, b.version, b.deleted]), [['board-0001', 1, false]]);
  assert.equal(l.body.usage.images, 2);
});

test('writes name the version they started from; a stale write is a conflict', async () => {
  assert.equal((await board('board-0001', 0)).status, 200);
  assert.equal((await board('board-0001', 1)).body.version, 2);
  const stale = await board('board-0001', 1);
  assert.equal(stale.status, 409); assert.equal(stale.body.version, 2);
  const again = await board('board-0001', 0);
  assert.equal(again.status, 409, 'creating a board that exists is a conflict too');
  assert.equal((await board('board-0002', 3)).status, 409, 'a write based on a version the server never had');
});

test('deleting leaves a marker other browsers can see, and frees the images', async () => {
  await upload(img(1));
  await board('board-0001', 0, [img(1)]);
  const del = await call('put', { id: 'board-0001', baseVersion: 1, deleted: true });
  assert.equal(del.status, 200);
  const got = await call('get', { id: 'board-0001' });
  assert.equal(got.body.deleted, true); assert.equal(got.body.data, null);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sync_refs').get().n, 0);
  // Brought back from another browser that still had it.
  assert.equal((await board('board-0001', 2, [img(1)])).body.version, 3);
});

test('images are stored once and only for their own key', async () => {
  assert.equal((await upload(img(7))).status, 200);
  assert.equal((await upload(img(7))).status, 200, 'uploading again is fine');
  assert.equal(env.SYNC.objects.size, 1);
  const own = await call('download', { id: img(7) });
  assert.deepEqual([...own.body], [1, 2, 3, 4]);
  assert.equal((await call('download', { id: img(7) }, { key: OTHER })).status, 404, 'another key cannot read it');
  assert.equal((await call('list', {}, { key: OTHER })).body.boards.length, 0);
  assert.equal((await call('get', { id: 'board-0001' }, { key: OTHER })).status, 404);
});

test('storage and board limits per key', async () => {
  env.SYNC_BYTES_PER_KEY = '10'; env.SYNC_MAX_BOARDS = '1';
  assert.equal((await upload(img(1), new Uint8Array(6))).status, 200);
  const full = await upload(img(2), new Uint8Array(6));
  assert.equal(full.status, 413); assert.match(full.body.error, /full/);
  assert.equal(env.SYNC.objects.size, 1, 'nothing stored when refused');
  assert.equal((await board('board-0001', 0, [], 'QQ==')).status, 200);
  const second = await board('board-0002', 0, [], 'QQ==');
  assert.equal(second.status, 413); assert.match(second.body.error, /up to 1 boards/);
  assert.equal((await board('board-0001', 1, [], 'QUFB')).status, 200, 'updating an existing board is fine');
});

test('bad input is refused', async () => {
  assert.equal((await upload('not-an-id')).status, 400);
  assert.equal((await upload(img(1), new Uint8Array(0))).status, 400);
  assert.equal((await call('put', { id: 'x', baseVersion: 0, data: 'QQ==' })).status, 400);
  assert.equal((await call('put', { id: 'board-0001', baseVersion: -1, data: 'QQ==' })).status, 400);
  assert.equal((await call('put', { id: 'board-0001', baseVersion: 0, data: 'not base64!' })).status, 400);
  assert.equal((await call('put', { id: 'board-0001', baseVersion: 0, data: 'QQ==', images: ['../etc'] })).status, 400);
  assert.equal((await call('put', { id: 'board-0001', baseVersion: 0, data: 'A'.repeat(1_600_000) })).status, 413);
  assert.equal((await call('nope', {})).status, 404);
});

test('only licensed browsers on the app origin can sync', async () => {
  assert.equal((await call('list', {}, { key: 'POLAR-UNKNOWN-0009' })).status, 404);
  assert.equal((await call('list', {}, { origin: 'https://evil.example' })).status, 403);
  // Refunded: the daily re-check with Polar finds the key revoked.
  await license(KEY, 'granted', Date.now() - 2 * DAY);
  globalThis.fetch = async (url) => Response.json(String(url).endsWith('/validate') ? { status: 'revoked' } : { id: 'act_1' });
  const r = await call('list');
  assert.equal(r.status, 403); assert.equal(r.body.pro, false);
  delete env.SYNC;
  assert.equal((await call('list', {}, { key: OTHER })).status, 503);
});

test('cleanup deletes images no board uses, after a week', async () => {
  await upload(img(1)); await upload(img(2)); await upload(img(3));
  await board('board-0001', 0, [img(1), img(2)]);
  await board('board-0001', 1, [img(1), img(3)]);   // img(2) replaced by img(3)
  const t0 = Date.now();
  await cleanupSync(env, t0);
  assert.equal(env.SYNC.objects.size, 3, 'nothing deleted on the first pass, only marked');
  await cleanupSync(env, t0 + 3 * DAY);
  assert.equal(env.SYNC.objects.size, 3, 'still within the grace period');
  // Used again before the week is up: kept.
  await board('board-0001', 2, [img(1), img(2), img(3)]);
  await board('board-0001', 3, [img(1)]);
  const r = await cleanupSync(env, t0 + 8 * DAY);
  assert.equal(r.removed, 0, 'img(2) and img(3) were only just unmarked or re-marked');
  await cleanupSync(env, t0 + 16 * DAY);
  const left = [...env.SYNC.objects.keys()].map(k => k.split('/')[1]);
  assert.deepEqual(left, [img(1)]);
  assert.deepEqual(env.DB.raw.prepare('SELECT id FROM sync_images').all().map(r => r.id), [img(1)]);
});

test('cleanup drops old deletion markers and data of keys revoked a month ago', async () => {
  await board('board-0001', 0);
  await call('put', { id: 'board-0001', baseVersion: 1, deleted: true });
  await cleanupSync(env, Date.now() + 91 * DAY);
  assert.equal((await call('get', { id: 'board-0001' })).status, 404);

  await upload(img(5), undefined, { key: OTHER });
  await call('put', { id: 'board-0009', baseVersion: 0, data: 'QQ==', images: [img(5)] }, { key: OTHER });
  await license(OTHER, 'revoked', Date.now() - 31 * DAY);
  await cleanupSync(env, Date.now());
  assert.equal(env.SYNC.objects.size, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sync_boards').get().n, 0);
});

test('delete-all removes everything for the key, and only that key', async () => {
  for (const n of [1, 2, 3, 4, 5]) await upload(img(n));
  await board('board-0001', 0, [img(1), img(2)]);
  await upload(img(9), undefined, { key: OTHER });
  assert.equal((await call('delete-all', {})).status, 200);
  assert.deepEqual([...env.SYNC.objects.keys()].map(k => k.split('/')[1]), [img(9)]);
  assert.equal((await call('list')).body.boards.length, 0);
  assert.equal((await call('list')).body.usage.bytes, 0);
  assert.ok((await call('list')).body.wipedAt > 0, 'other browsers learn the data was deleted');
  assert.equal((await call('list', {}, { key: OTHER })).body.wipedAt, 0);
  const stale = await call('put', { id: 'board-0001', baseVersion: 0, data: 'QQ==', images: [] });
  assert.equal(stale.status, 409, 'a browser that missed the deletion cannot upload again');
  assert.equal(stale.body.error, 'wiped');
  const { wipedAt } = (await call('list')).body;
  assert.equal((await call('put', { id: 'board-0001', baseVersion: 0, data: 'QQ==', images: [], wipedAt })).status, 200, 'after seeing it, a deliberate re-upload works');
});
