// End-to-end check of saving and Pro sync: real browsers against the real sync server code.
// /api/sync/* is answered in this process by functions/api/sync.js (D1 and R2 faked in memory),
// so two browser contexts sync through one "server". Usage: cd tests && node sync-e2e.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost as syncHandler, cleanupSync } from '../functions/api/sync.js';
import { fakeD1, fakeR2 } from './fakes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 8766;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'POLAR-TEST-KEY-SYNC-0001';
const out = path.join(here, 'out');
await fs.mkdir(out, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// --- The "server": real handler, fake storage, Polar answered here ------------------------------
const env = { DB: fakeD1(), SYNC: fakeR2(), POLAR_ACCESS_TOKEN: 'polar_oat_test', POLAR_ORGANIZATION_ID: 'org_test', ALLOWED_ORIGIN: BASE };
let polarStatus = 'granted';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/v1/license-keys/')) {
    return String(url).endsWith('/activate') ? Response.json({ id: `act_${Math.random()}` }) : Response.json({ status: polarStatus });
  }
  return realFetch(url, init);
};
let offline = false, syncCalls = 0;

async function attach(context) {
  await context.route('**/api/license', route => route.fulfill({ json: polarStatus === 'granted' ? { valid: true, message: 'Pro unlocked.' } : { valid: false, message: 'This license was refunded or revoked.' }, status: polarStatus === 'granted' ? 200 : 403 }));
  await context.route('**/api/sync/**', async route => {
    if (offline) return route.abort('internetdisconnected');
    syncCalls++;
    const r = route.request();
    const headers = Object.fromEntries(Object.entries(await r.allHeaders()).filter(([k]) => !['origin', 'host', 'content-length'].includes(k)));
    const res = await syncHandler({
      env,
      request: new Request(r.url(), { method: r.method(), headers: { ...headers, Origin: BASE, 'CF-Connecting-IP': '9.9.9.9' }, body: r.postDataBuffer() }),
    });
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
}

const browser = await chromium.launch();
async function open(label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await attach(context);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(`${label}: ${e.message}`));
  await page.goto(BASE);
  await page.waitForFunction(() => window.__dss?.ready);
  return { context, page };
}
const ready = (page) => page.waitForFunction(() => window.__dss?.ready);
const menu = async (page) => { if (!(await page.evaluate(() => document.getElementById('boardMenu').matches(':popover-open')))) await page.click('#boardSwitch'); };
const state = (page, fn) => page.evaluate(fn);
async function unlock(page) {
  await page.click('#licenseBadge');
  await page.fill('#licenseKey', KEY);
  await page.click('#licenseBtn');
  await page.waitForFunction(() => window.__dss.state.licensed);
  await page.keyboard.press('Escape');
}
async function syncNow(page) {
  await page.evaluate(async () => { await window.__dss.saveNow(); await window.__dss.sync().run(); });
}
const syncState = (page) => page.evaluate(() => window.__dss.sync().status);
async function setHeadline(page, text, shot = 0) {
  await page.evaluate(([text, shot]) => {
    const s = window.__dss.state.shots[shot];
    const screen = Object.keys(s.text.en)[0];
    s.text.en[screen] = { ...s.text.en[screen], headline: text };
    s.edited = true;
    return window.__dss.saveNow();
  }, [text, shot]);
}
const headline = (page, shot = 0) => page.evaluate((shot) => { const s = window.__dss.state.shots[shot]; return s && s.text.en[Object.keys(s.text.en)[0]].headline; }, shot);
const boardNames = (page) => page.evaluate(async () => {
  const db = await new Promise(r => { const o = indexedDB.open('hhstudio'); o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('boards').objectStore('boards').getAll(); q.onsuccess = () => r(q.result); });
  return all.filter(b => !b.deleted).map(b => b.name).sort();
});

try {
  // ---------- Local saving ----------
  const { context: ctxA, page: a } = await open('A');
  await a.click('.tile[data-family="duo"] .tile-select');
  await a.click('#deviceDone');
  await a.click('#sampleBtn');
  await a.waitForFunction(() => window.__dss.state.shots.length === 4);
  await setHeadline(a, 'Kept after reload');
  await a.reload(); await ready(a);
  check(await headline(a) === 'Kept after reload', 'Edits survive a reload');
  check(await state(a, () => window.__dss.state.shots.filter(s => Object.keys(s.images).length).length) === 4, 'Captures survive a reload');
  check(!(await a.isVisible('#deviceDialog')), 'Coming back does not ask for a device again');
  const stored = await a.evaluate(async () => {
    const db = await new Promise(r => { const o = indexedDB.open('hhstudio'); o.onsuccess = () => r(o.result); });
    const all = await new Promise(r => { const q = db.transaction('images').objectStore('images').getAll(); q.onsuccess = () => r(q.result); });
    return all.map(i => ({ type: i.blob.type, kb: i.bytes / 1024 }));
  });
  check(stored.length === 4 && stored.every(i => i.type === 'image/webp' && i.kb < 600), `Captures are stored compressed: ${stored.map(i => Math.round(i.kb) + ' KB').join(', ')}`);

  // Boards: rename, new, switch, duplicate, delete.
  await a.click('#boardSwitch');
  await a.fill('#boardName', 'HearHere launch');
  await a.press('#boardName', 'Enter');
  await a.keyboard.press('Escape');
  await a.waitForFunction(() => document.getElementById('boardSwitchName').textContent === 'HearHere launch');
  check(true, 'A board can be renamed');
  await a.click('#boardSwitch'); await a.click('#boardNew');
  await a.waitForSelector('#deviceDialog[open]');
  await a.click('.tile[data-family="iphone"] .tile-select'); await a.click('#deviceDone');
  await a.waitForFunction(() => window.__dss.state.groups[0]?.device.startsWith('iphone'));
  check(await state(a, () => window.__dss.state.shots.length) === 1, 'New board starts empty, with the device picked');
  await setHeadline(a, 'Second board');
  check((await boardNames(a)).join() === 'HearHere launch,Untitled board', 'Both boards are saved');
  await a.click('#boardSwitch');
  await a.click('#boardList .board-row:has-text("HearHere launch")');
  await a.waitForFunction(() => window.__dss.state.shots.length === 4);
  check(await headline(a) === 'Kept after reload', 'Switching boards brings back the other one');
  await a.click('#boardSwitch'); await a.click('#boardDuplicate');
  await a.waitForFunction(() => document.getElementById('boardSwitchName').textContent === 'HearHere launch copy');
  check((await boardNames(a)).length === 3, 'Duplicate makes a third board');
  a.once('dialog', d => d.accept());
  await a.click('#boardSwitch'); await a.click('#boardDelete');
  await a.waitForFunction(() => document.getElementById('boardSwitchName').textContent !== 'HearHere launch copy');
  check((await boardNames(a)).join() === 'HearHere launch,Untitled board', 'Delete removes only that board');

  // Backup round trip.
  await a.click('#boardSwitch');
  await a.click('#boardList .board-row:has-text("HearHere launch")');
  await a.waitForFunction(() => window.__dss.state.shots.length === 4);
  await a.click('#boardSwitch');
  const [dl] = await Promise.all([a.waitForEvent('download'), a.click('#boardExport')]);
  const backup = path.join(out, 'board.hhstudio');
  await dl.saveAs(backup);
  check((await fs.stat(backup)).size > 100_000, `Backup file holds the captures (${Math.round((await fs.stat(backup)).size / 1024)} KB)`);
  const { context: ctxC, page: c } = await open('C');
  await c.click('.tile[data-family="iphone"] .tile-select'); await c.click('#deviceDone');
  await c.click('#boardSwitch');
  const [chooser] = await Promise.all([c.waitForEvent('filechooser'), c.click('#boardImport')]);
  await chooser.setFiles(backup);
  await c.waitForFunction(() => window.__dss.state.shots.length === 4 && window.__dss.state.shots.every(s => Object.keys(s.images).length));
  check(await headline(c) === 'Kept after reload', 'A backup opens in another browser with text and captures');
  await ctxC.close();

  // ---------- Sync ----------
  await unlock(a);
  await a.click('#boardSwitch');
  check((await a.textContent('#syncNote')).includes('Off'), 'Sync is off until turned on');
  await a.click('#syncToggle');
  await a.waitForFunction(() => window.__dss.sync().status.state === 'synced', null, { timeout: 30_000 })
    .catch(async e => { console.log('status', JSON.stringify(await syncState(a)), 'calls', syncCalls, a.errors); throw e; });
  await a.keyboard.press('Escape');
  check(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sync_boards').get().n === 2, 'Turning sync on uploads both boards');
  check(env.SYNC.objects.size === 4, `Each capture is uploaded once (${env.SYNC.objects.size})`);

  // The server can't read anything.
  const plainText = JSON.stringify(env.DB.raw.prepare('SELECT * FROM sync_boards').all());
  check(!plainText.includes('Kept after reload') && !plainText.includes('HearHere launch'), 'Board text and names are encrypted on the server');
  const anyWebp = [...env.SYNC.objects.values()].some(b => Buffer.from(b.subarray(8, 12)).toString() === 'WEBP');
  check(!anyWebp, 'Images are encrypted on the server');

  // Browser B with the same key gets everything.
  const { context: ctxB, page: b } = await open('B');
  await b.click('.tile[data-family="iphone"] .tile-select'); await b.click('#deviceDone');
  await unlock(b);
  await b.click('#boardSwitch'); await b.click('#syncToggle'); await b.keyboard.press('Escape');
  await b.waitForFunction(() => window.__dss.sync().status.state === 'synced', null, { timeout: 30_000 });
  const namesB = await boardNames(b);
  check(namesB.join() === 'HearHere launch,Untitled board', `B gets A's two boards, and drops its own untouched starter board: ${namesB.join(', ')}`);
  check(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sync_boards').get().n === 2, 'An untouched starter board is never uploaded');
  await b.click('#boardSwitch');
  await b.click('#boardList .board-row:has-text("HearHere launch")');
  await b.waitForFunction(() => window.__dss.state.shots.length === 4 && window.__dss.state.shots.every(s => Object.keys(s.images).length));
  check(await headline(b) === 'Kept after reload', 'B opens the synced board with its captures');

  // An edit in B reaches A.
  await setHeadline(b, 'Edited in B');
  await syncNow(b);
  await syncNow(a);
  await a.waitForFunction(() => window.__dss.state.shots[0].text.en[Object.keys(window.__dss.state.shots[0].text.en)[0]].headline === 'Edited in B', null, { timeout: 10_000 });
  check(true, 'An edit in one browser shows up in the other');

  // Both edit while offline: nothing is lost.
  offline = true;
  await setHeadline(a, 'A offline edit');
  await syncNow(a);
  check((await syncState(a)).state === 'offline', 'Offline is reported, not an error');
  await setHeadline(b, 'B offline edit');
  offline = false;
  await syncNow(b);   // B gets there first
  await syncNow(a);   // A finds B's version: keeps its own, adds B's as a copy
  await syncNow(b);
  const namesA = await boardNames(a);
  check(await headline(a) === 'A offline edit', 'A keeps its own edit after a conflict');
  check(namesA.some(n => n.includes('(from another browser)')), `B's edit is kept as a copy: ${namesA.join(', ')}`);
  check((await boardNames(b)).some(n => n.includes('(from another browser)')), 'The copy reaches B too');

  // A deletion travels.
  a.once('dialog', d => d.accept());
  await a.click('#boardSwitch'); await a.click('#boardList .board-row:has-text("from another browser")');
  await a.waitForFunction(() => document.getElementById('boardSwitchName').textContent.includes('from another browser'));
  await a.click('#boardSwitch'); await a.click('#boardDelete');
  await a.waitForFunction(() => !document.getElementById('boardSwitchName').textContent.includes('from another browser'));
  await syncNow(a); await syncNow(b);
  check(!(await boardNames(b)).some(n => n.includes('(from another browser)')), 'Deleting a board removes it from the other browser');

  // Replaced captures are cleaned up on the server a week later.
  const before = env.SYNC.objects.size;
  await cleanupSync(env, Date.now());
  await cleanupSync(env, Date.now() + 8 * 24 * 60 * 60 * 1000);
  check(env.SYNC.objects.size <= before, `Cleanup keeps every capture a board still uses (${env.SYNC.objects.size} of ${before})`);
  await syncNow(b);
  await b.reload(); await ready(b);
  check(await b.evaluate(() => window.__dss.state.shots.every(s => Object.keys(s.images).length || !s.missing)), 'Boards still open fully after the cleanup');

  // Delete synced data in A: B stops instead of uploading it all again.
  a.once('dialog', d => d.accept());
  await a.click('#boardSwitch'); await a.click('#syncDelete');
  await a.waitForFunction(() => !window.__dss.sync().enabled);
  check(env.SYNC.objects.size === 0 && env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sync_boards').get().n === 0, 'Delete synced data empties the server');
  await setHeadline(b, 'B after wipe');
  await syncNow(b);
  check(!(await b.evaluate(() => window.__dss.sync().enabled)), 'The other browser turns sync off');
  check(env.SYNC.objects.size === 0, 'and uploads nothing');
  check((await boardNames(b)).length >= 2, 'Its boards stay saved locally');

  // Revoked license: sync stops with a clear message.
  await menu(a); await a.click('#syncToggle'); await a.keyboard.press('Escape');
  await a.waitForFunction(() => window.__dss.sync().status.state === 'synced', null, { timeout: 30_000 });
  polarStatus = 'revoked';
  env.DB.raw.prepare('UPDATE licenses SET checked_at = 0').run();
  await setHeadline(a, 'After refund');
  await syncNow(a);
  const st = await syncState(a);
  check(st.state === 'error' && /license|revoked/i.test(st.message), `A refunded key stops sync: "${st.message}"`);
  check(await headline(a) === 'After refund', 'Local editing keeps working');

  const errors = [...a.errors, ...b.errors];
  check(errors.length === 0, `No page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await a.screenshot({ path: path.join(out, 'sync-a.png') });
  await ctxA.close(); await ctxB.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
