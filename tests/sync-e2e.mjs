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
import { PNG } from 'pngjs';

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
async function open(label, { init } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  if (init) await context.addInitScript(init);
  await attach(context);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(`${label}: ${e.message}`));
  await page.goto(BASE);
  await page.waitForFunction(() => window.__dss?.ready);
  return { context, page };
}
const ready = (page) => page.waitForFunction(() => window.__dss?.ready);
const title = (page) => page.inputValue('#boardTitle');
async function rename(page, name) { await page.fill('#boardTitle', name); await page.press('#boardTitle', 'Enter'); await page.waitForFunction((n) => window.__dss.board()?.name === n, name); }
async function home(page) { if (await page.isHidden('#home')) await page.click('#toBoards'); await page.waitForSelector('#home:not([hidden]) .board-card'); }
const card = (name) => `.board-card:has(.board-card-name:text-is("${name}"))`;
async function openCard(page, name) { await home(page); await page.click(`${card(name)} .board-preview`); await page.waitForFunction((n) => window.__dss.board()?.name === n && document.getElementById('home').hidden, name); }
async function cardAction(page, name, action) { await home(page); await page.click(`${card(name)} .board-more`); await page.click(`#cardMenu [data-a="${action}"]`); }
async function syncSwitch(page) {
  if (!(await page.evaluate(() => document.getElementById('licensePop').matches(':popover-open')))) await page.click('#licenseBadge');
  await page.click('#syncToggle');
  await page.keyboard.press('Escape');
}
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

  // Boards: rename in the side panel; new, open, duplicate and delete on the Boards page.
  await rename(a, 'HearHere launch');
  check(true, 'A board can be renamed from the side panel');
  await a.click('#toBoards');
  await a.waitForSelector('#home:not([hidden])');
  check(await a.evaluate(() => location.hash) === '#boards' && await a.isVisible(card('HearHere launch')), 'The Boards page lists the board');
  await a.click('#homeNew');
  await a.waitForSelector('#deviceDialog[open]');
  await a.click('.tile[data-family="iphone"] .tile-select'); await a.click('#deviceDone');
  await a.waitForFunction(() => window.__dss.state.groups[0]?.device.startsWith('iphone') && document.getElementById('home').hidden);
  check(await state(a, () => window.__dss.state.shots.length) === 1, 'New board opens empty, with the device picked');
  await setHeadline(a, 'Second board');
  check((await boardNames(a)).join() === 'HearHere launch,Untitled board', 'Both boards are saved');
  await openCard(a, 'HearHere launch');
  await a.waitForFunction(() => window.__dss.state.shots.length === 4);
  check(await headline(a) === 'Kept after reload', 'Opening a board from the Boards page brings it back');
  await a.goBack();
  await a.waitForSelector('#home:not([hidden])');
  await a.goForward();
  await a.waitForFunction(() => document.getElementById('home').hidden);
  check(true, 'Back and forward move between the board and the Boards page');
  await cardAction(a, 'HearHere launch', 'duplicate');
  await a.waitForSelector(card('HearHere launch copy'));
  check((await boardNames(a)).length === 3, 'Duplicate adds a copy on the Boards page');
  a.once('dialog', d => d.accept());
  await cardAction(a, 'HearHere launch copy', 'delete');
  await a.waitForFunction(() => !document.querySelector('.board-card .board-card-name')?.closest('#homeGrid')?.textContent.includes('launch copy'));
  check((await boardNames(a)).join() === 'HearHere launch,Untitled board', 'Delete removes only that board');
  await cardAction(a, 'Untitled board', 'rename');
  await a.fill('.board-card-input', 'Second');
  await a.press('.board-card-input', 'Enter');
  await a.waitForSelector(card('Second'));
  check((await boardNames(a)).join() === 'HearHere launch,Second', 'A board can be renamed on the Boards page');

  // Backup round trip.
  const [dl] = await Promise.all([a.waitForEvent('download'), cardAction(a, 'HearHere launch', 'export')]);
  const backup = path.join(out, 'board.hhstudio');
  await dl.saveAs(backup);
  check((await fs.stat(backup)).size > 100_000, `Backup file holds the captures (${Math.round((await fs.stat(backup)).size / 1024)} KB)`);
  await openCard(a, 'HearHere launch');
  const { context: ctxC, page: c } = await open('C');
  await c.click('.tile[data-family="iphone"] .tile-select'); await c.click('#deviceDone');
  await home(c);
  const [chooser] = await Promise.all([c.waitForEvent('filechooser'), c.click('#homeImport')]);
  await chooser.setFiles(backup);
  await c.waitForFunction(() => window.__dss.state.shots.length === 4 && window.__dss.state.shots.every(s => Object.keys(s.images).length));
  check(await headline(c) === 'Kept after reload', 'A backup opens in another browser with text and captures');
  await ctxC.close();

  // ---------- Hardening ----------
  // Two tabs on the same board: an edit in one shows up in the other.
  const a2 = await ctxA.newPage();
  a2.errors = [];
  a2.on('pageerror', e => a2.errors.push(`A2: ${e.message}`));
  await a2.goto(BASE); await ready(a2);
  check(await headline(a2) === 'Kept after reload', 'A second tab opens the same board');
  await setHeadline(a, 'Edited in tab one');
  await a2.waitForFunction(() => window.__dss.state.shots[0].text.en[Object.keys(window.__dss.state.shots[0].text.en)[0]].headline === 'Edited in tab one', null, { timeout: 5000 })
    .then(() => check(true, 'The other tab follows the edit'), () => check(false, 'The other tab follows the edit'));
  await a2.close();
  await setHeadline(a, 'Kept after reload');

  // A huge capture is scaled down to what any export can use.
  const big = new PNG({ width: 3000, height: 6000 });
  big.data.fill(200);
  const bigFile = path.join(out, 'big-capture.png');
  await fs.writeFile(bigFile, PNG.sync.write(big));
  const { context: ctxD, page: d } = await open('D');
  await d.click('.tile[data-family="iphone"] .tile-select'); await d.click('#deviceDone');
  await d.setInputFiles('#fileInput', bigFile);
  await d.waitForFunction(() => window.__dss.state.shots.some(s => Object.keys(s.images).length));
  const dims = await d.evaluate(() => { const img = Object.values(window.__dss.state.shots.find(s => Object.keys(s.images).length).images)[0]; return [img.naturalWidth, img.naturalHeight]; });
  check(Math.max(...dims) === 2868, `A 3000 × 6000 capture is kept at ${dims.join(' × ')}`);

  // A board from a newer version of the app doesn't break this one.
  await d.evaluate(async () => {
    await window.__dss.saveNow();
    const db = await new Promise(r => { const o = indexedDB.open('hhstudio'); o.onsuccess = () => r(o.result); });
    const t = db.transaction(['boards', 'meta'], 'readwrite');
    t.objectStore('boards').put({ id: 'future-board-0001', name: 'From the future', doc: { format: 99, groups: [] }, createdAt: 1, updatedAt: Date.now() + 1e9, remoteVersion: 0, dirty: false });
    t.objectStore('meta').put('future-board-0001', 'current');
    await new Promise(r => { t.oncomplete = r; });
  });
  await d.reload(); await ready(d);
  check((await d.textContent('#toast')).includes('newer version'), 'A board from a newer version explains itself');
  check(await d.evaluate(() => window.__dss.state.groups.length > 0) && d.errors.length === 0, 'and the app still works');
  await ctxD.close();

  // No IndexedDB (some private windows): everything works, it just says it isn't saved.
  const { context: ctxE, page: e } = await open('E', { init: () => { Object.defineProperty(window, 'indexedDB', { value: { open() { throw new Error('blocked'); } } }); } });
  await e.click('.tile[data-family="duo"] .tile-select'); await e.click('#deviceDone');
  await e.click('#sampleBtn');
  await e.waitForFunction(() => window.__dss.state.shots.length === 4 && window.__dss.state.shots.every(s => Object.keys(s.images).length));
  check((await e.textContent('#saveStatus')).includes('Not saved'), 'Without browser storage the app says boards aren’t saved');
  check(e.errors.length === 0, `and nothing breaks${e.errors.length ? ': ' + e.errors.join(' | ') : ''}`);
  await ctxE.close();

  // ---------- Sync ----------
  // Pro turns sync on by itself. If the server can't store anything yet, it says so and keeps trying.
  const r2 = env.SYNC; delete env.SYNC;
  await unlock(a);
  await a.waitForFunction(() => window.__dss.sync().status.state === 'error', null, { timeout: 15_000 });
  check(await a.evaluate(() => window.__dss.sync().enabled), 'Sync turns on by itself with Pro');
  check((await syncState(a)).message.includes('isn’t available right now'), 'A server without storage is reported, and sync stays on to retry');
  env.SYNC = r2;
  await syncNow(a);
  await a.waitForFunction(() => window.__dss.sync().status.state === 'synced', null, { timeout: 30_000 })
    .catch(async e => { console.log('status', JSON.stringify(await syncState(a)), 'calls', syncCalls, a.errors); throw e; });
  check(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sync_boards').get().n === 2, 'Sync uploads both boards');
  check(env.SYNC.objects.size === 4, `Each capture is uploaded once (${env.SYNC.objects.size})`);
  await a.click('#licenseBadge');
  check((await a.textContent('#syncNote')).includes('End-to-end encrypted'), 'The Pro panel shows sync is on and encrypted');
  await a.keyboard.press('Escape');

  // The server can't read anything.
  const plainText = JSON.stringify(env.DB.raw.prepare('SELECT * FROM sync_boards').all());
  check(!plainText.includes('Kept after reload') && !plainText.includes('HearHere launch'), 'Board text and names are encrypted on the server');
  const anyWebp = [...env.SYNC.objects.values()].some(b => Buffer.from(b.subarray(8, 12)).toString() === 'WEBP');
  check(!anyWebp, 'Images are encrypted on the server');

  // Browser B with the same key gets everything, without touching a switch.
  const { context: ctxB, page: b } = await open('B');
  await b.click('.tile[data-family="iphone"] .tile-select'); await b.click('#deviceDone');
  await unlock(b);
  await b.waitForFunction(() => window.__dss.sync().status.state === 'synced', null, { timeout: 30_000 });
  await b.waitForFunction(() => window.__dss.board()?.name === 'HearHere launch', null, { timeout: 15_000 }).catch(() => {});
  check(await title(b) === 'HearHere launch', `B opens the most recently edited synced board (${await title(b)})`);
  const namesB = await boardNames(b);
  check(namesB.join() === 'HearHere launch,Second', `B gets A's two boards, and drops its own untouched starter board: ${namesB.join(', ')}`);
  check(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sync_boards').get().n === 2, 'An untouched starter board is never uploaded');
  await openCard(b, 'HearHere launch');
  await b.waitForFunction(() => window.__dss.state.shots.length === 4 && window.__dss.state.shots.every(s => Object.keys(s.images).length));
  check(await headline(b) === 'Kept after reload', 'B opens the synced board with its captures');

  // An edit in B reaches A.
  await setHeadline(b, 'Edited in B');
  await syncNow(b);
  await syncNow(a);
  await a.waitForFunction(() => window.__dss.state.shots[0].text.en[Object.keys(window.__dss.state.shots[0].text.en)[0]].headline === 'Edited in B', null, { timeout: 10_000 });
  check(true, 'An edit in one browser shows up in the other');

  // A rename travels too.
  await rename(a, 'HearHere 3.2');
  await syncNow(a); await syncNow(b);
  await b.waitForFunction(() => document.getElementById('boardTitle').value === 'HearHere 3.2', null, { timeout: 10_000 })
    .then(() => check(true, 'Renaming a board reaches the other browser'), () => check(false, 'Renaming a board reaches the other browser'));

  // A capture missing on the server: the board still opens, and editing it doesn't drop that capture.
  const [lostKey, lostBytes] = [...env.SYNC.objects.entries()][0];
  env.SYNC.objects.delete(lostKey);
  const { context: ctxF, page: f } = await open('F');
  await f.click('.tile[data-family="iphone"] .tile-select'); await f.click('#deviceDone');
  await unlock(f);
  await f.waitForFunction(() => window.__dss.sync().status.state !== 'syncing', null, { timeout: 30_000 });
  await f.waitForFunction(() => window.__dss.board()?.name === 'HearHere 3.2', null, { timeout: 10_000 });
  const lost = await f.evaluate(() => window.__dss.state.shots.filter(s => s.missing).length);
  check(lost === 1 && await headline(f) === 'Edited in B', `A board with a missing capture still opens (${lost} capture waiting)`);
  await setHeadline(f, 'Edited in F');
  const keptRef = await f.evaluate(async () => {
    const db = await new Promise(r => { const o = indexedDB.open('hhstudio'); o.onsuccess = () => r(o.result); });
    const cur = await new Promise(r => { const q = db.transaction('meta').objectStore('meta').get('current'); q.onsuccess = () => r(q.result); });
    const rec = await new Promise(r => { const q = db.transaction('boards').objectStore('boards').get(cur); q.onsuccess = () => r(q.result); });
    return rec.doc.groups.flatMap(g => g.shots).filter(s => Object.keys(s.images).length).length;
  });
  check(keptRef === 4, 'Editing that board keeps the missing capture in place');
  env.SYNC.objects.set(lostKey, lostBytes);   // the server has it again: the next sync fills it in
  await f.evaluate(() => window.__dss.sync().run());
  await syncNow(f);
  await f.reload(); await ready(f);
  check(await f.evaluate(() => window.__dss.state.shots.every(s => !s.missing)), 'Once it’s back on the server it fills in');
  await ctxF.close();
  await syncNow(a); await syncNow(b);

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
  const copyName = (await boardNames(a)).find(n => n.includes('(from another browser)'));
  await cardAction(a, copyName, 'delete');
  await a.waitForFunction(() => ![...document.querySelectorAll('.board-card-name')].some(e => e.textContent.includes('from another browser')));
  await openCard(a, 'HearHere 3.2');
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
  await a.click('#licenseBadge'); await a.click('#syncDelete'); await a.keyboard.press('Escape');
  await a.waitForFunction(() => !window.__dss.sync().enabled);
  check(env.SYNC.objects.size === 0 && env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sync_boards').get().n === 0, 'Delete synced data empties the server');
  await setHeadline(b, 'B after wipe');
  await syncNow(b);
  check(!(await b.evaluate(() => window.__dss.sync().enabled)), 'The other browser turns sync off');
  check(env.SYNC.objects.size === 0, 'and uploads nothing');
  check((await boardNames(b)).length >= 2, 'Its boards stay saved locally');

  // Revoked license: sync stops with a clear message.
  await syncSwitch(a);
  await a.waitForFunction(() => window.__dss.sync().status.state === 'synced', null, { timeout: 30_000 });
  check(await a.evaluate(() => window.__dss.sync().enabled), 'Sync can be switched back on from the Pro panel');
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
