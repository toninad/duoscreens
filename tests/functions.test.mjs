// Tests for the Cloudflare Pages Functions (/api/license, /api/translate) without Cloudflare:
// D1 is emulated with node:sqlite and the real schema, Polar and Anthropic are faked by stubbing fetch.
// Run: npm run test:functions
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequestPost as license } from '../functions/api/license.js';
import { onRequestPost as translate } from '../functions/api/translate.js';

// --- D1 stand-in: the subset of the D1 API the functions use -------------------------------------
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      const stmt = db.prepare(sql.replace(/\?(\d+)/g, '?'));
      // D1 numbers params ?1, ?2…; node:sqlite takes them positionally, so expand by index.
      const order = [...sql.matchAll(/\?(\d+)/g)].map(m => Number(m[1]) - 1);
      let args = [];
      const api = {
        bind(...a) { args = order.map(i => a[i]); return api; },
        async first() { return stmt.get(...args) ?? null; },
        async run() { stmt.run(...args); return { success: true }; },
        async all() { return { results: stmt.all(...args) }; },
      };
      return api;
    },
  };
}

// --- Fake Polar + Anthropic -------------------------------------------------------------------------
const VALID_KEY = 'POLAR-GOOD-KEY-0001';
let polarCalls, anthropicCalls, polarState;
const realFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init.body ? JSON.parse(typeof init.body === 'string' ? init.body : await new Response(init.body).text()) : {};
    if (url.includes('/v1/license-keys/')) {
      polarCalls.push({ url, body });
      if (body.key !== VALID_KEY) return Response.json({ detail: 'Not found' }, { status: 404 });
      if (url.endsWith('/activate')) {
        if (polarState.activations >= 3) return Response.json({ detail: 'License key activation limit reached' }, { status: 403 });
        polarState.activations++;
        return Response.json({ id: `act_${polarState.activations}`, label: body.label });
      }
      return Response.json({ id: 'lk_1', status: polarState.status, key: body.key });
    }
    if (url.startsWith('https://api.anthropic.com/v1/messages')) {
      anthropicCalls.push(body);
      const texts = JSON.parse(body.messages[0].content);
      const lang = body.system.match(/to ([^.]+)\./)[1];
      return Response.json({
        id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ translations: texts.map(t => `[${lang}] ${t}`) }) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }, { headers: { 'request-id': 'req_1' } });
    }
    return realFetch(input, init);
  };
}

const ORIGIN = 'https://studio.hearhere.media';
let env;
beforeEach(() => {
  polarCalls = []; anthropicCalls = []; polarState = { activations: 0, status: 'granted' };
  env = {
    DB: fakeD1(), POLAR_ACCESS_TOKEN: 'polar_oat_test', POLAR_ORGANIZATION_ID: 'org_test',
    ANTHROPIC_API_KEY: 'sk-ant-test', ALLOWED_ORIGIN: ORIGIN, TRANSLATION_RUNS_PER_MONTH: '5',
  };
  stubFetch();
});

const req = (path, body, origin = ORIGIN, ip = '1.2.3.4') => new Request(`${ORIGIN}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip }, body: JSON.stringify(body),
});
const call = async (fn, path, body, ...rest) => { const r = await fn({ request: req(path, body, ...rest), env }); return { status: r.status, body: await r.json() }; };
const DEVICE = 'device-aaaaaaaa-0001';

test('valid key activates the device once, then answers from the cache', async () => {
  const a = await call(license, '/api/license', { key: VALID_KEY, device: DEVICE });
  assert.equal(a.status, 200); assert.equal(a.body.valid, true);
  assert.deepEqual(polarCalls.map(c => c.url.split('/').pop()), ['activate', 'validate']);
  assert.equal(polarCalls[0].body.organization_id, 'org_test');
  const b = await call(license, '/api/license', { key: VALID_KEY, device: DEVICE });
  assert.equal(b.body.valid, true);
  assert.equal(polarCalls.length, 2, 'second check within a day does not call Polar');
  const stored = env.DB.raw.prepare('SELECT key_hash FROM licenses').get().key_hash;
  assert.notEqual(stored, VALID_KEY); assert.equal(stored.length, 64, 'only the SHA-256 is stored');
});

test('unknown key is rejected', async () => {
  const r = await call(license, '/api/license', { key: 'NOPE-NOPE-NOPE', device: DEVICE });
  assert.equal(r.status, 404); assert.equal(r.body.valid, false);
});

test('fourth device hits the activation limit', async () => {
  for (let i = 1; i <= 3; i++) assert.equal((await call(license, '/api/license', { key: VALID_KEY, device: `device-aaaaaaaa-000${i}` })).status, 200);
  const r = await call(license, '/api/license', { key: VALID_KEY, device: 'device-aaaaaaaa-0004' });
  assert.equal(r.status, 403); assert.match(r.body.message, /maximum number of devices/);
});

test('refunded (revoked) key is rejected', async () => {
  polarState.status = 'revoked';
  const r = await call(license, '/api/license', { key: VALID_KEY, device: DEVICE });
  assert.equal(r.status, 403); assert.match(r.body.message, /refunded or revoked/);
});

test('calls from another site are refused', async () => {
  const r = await call(license, '/api/license', { key: VALID_KEY, device: DEVICE }, 'https://evil.example');
  assert.equal(r.status, 403); assert.equal(polarCalls.length, 0);
});

test('rate limit kicks in after 20 license checks a minute from one IP', async () => {
  let last;
  for (let i = 0; i < 21; i++) last = await call(license, '/api/license', { key: 'NOPE-NOPE-NOPE', device: DEVICE });
  assert.equal(last.status, 429);
});

test('translate: needs a valid license', async () => {
  const r = await call(translate, '/api/translate', { key: 'NOPE-NOPE-NOPE', device: DEVICE, targetLanguages: ['de'], texts: ['Hi'] });
  assert.equal(r.status, 404); assert.equal(anthropicCalls.length, 0);
});

test('translate: one request per language, counted against the allowance', async () => {
  const r = await call(translate, '/api/translate', { key: VALID_KEY, device: DEVICE, sourceLanguage: 'en', targetLanguages: ['de', 'ja'], texts: ['Every show, side by side', ''] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.translations.de, ['[German] Every show, side by side', '[German] ']);
  assert.equal(r.body.translations.ja.length, 2);
  assert.deepEqual(r.body.usage, { runs: 2, limit: 5 });
  assert.equal(anthropicCalls.length, 2);
  const sent = anthropicCalls[0];
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.ok(!JSON.stringify(sent).includes(VALID_KEY), 'license key is never sent to Anthropic');
});

test('translate: monthly allowance is enforced', async () => {
  await call(translate, '/api/translate', { key: VALID_KEY, device: DEVICE, targetLanguages: ['de', 'fr', 'es'], texts: ['Hi'] });
  const r = await call(translate, '/api/translate', { key: VALID_KEY, device: DEVICE, targetLanguages: ['it', 'nl', 'pl'], texts: ['Hi'] });
  assert.equal(r.status, 429); assert.match(r.body.error, /allowance/);
});

test('translate: rejects unsupported languages and oversized input', async () => {
  assert.equal((await call(translate, '/api/translate', { key: VALID_KEY, device: DEVICE, targetLanguages: ['xx'], texts: ['Hi'] })).status, 400);
  assert.equal((await call(translate, '/api/translate', { key: VALID_KEY, device: DEVICE, targetLanguages: ['de'], texts: ['x'.repeat(301)] })).status, 413);
});
