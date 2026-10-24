// End-to-end check: serve the app, upload a screenshot, translate (mocked), export, verify the ZIP.
// Usage: cd tests && npm install && npx playwright install chromium && node e2e.mjs
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;
// Apple's iPhone Duo sizes, portrait and landscape.
const VALID = { inner: ['2007x2853', '2853x2007'], outer: ['1398x2034', '2034x1398'] };
const out = path.join(here, 'out');
await fs.mkdir(out, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

function pngInfo(buf) {
  const sig = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  return { sig, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

async function exportZip(page, label) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.click('#exportBtn')]);
  const file = path.join(out, `${label}.zip`);
  await dl.saveAs(file);
  return { file, zip: await JSZip.loadAsync(await fs.readFile(file)) };
}

async function verifyZip(zip, label, expectedCount) {
  const pngs = Object.keys(zip.files).filter(n => n.endsWith('.png')).sort();
  check(pngs.length === expectedCount, `${label}: ZIP has ${pngs.length} PNGs (expected ${expectedCount}): ${pngs.join(', ')}`);
  for (const name of pngs) {
    const info = pngInfo(Buffer.from(await zip.file(name).async('uint8array')));
    const [, display, folder] = name.match(/iPhone-Duo-(inner|outer)-(\d+x\d+)\//);
    const [w, h] = folder.split('x').map(Number);
    check(VALID[display].includes(folder), `${label}: ${folder} is an App Store size for the ${display} display`);
    check(info.sig && info.width === w && info.height === h, `${label}: ${name} is ${info.width}×${info.height} (expected ${w}×${h})`);
    check(info.colorType === 2 && info.bitDepth === 8, `${label}: ${name} is 8-bit RGB without alpha (colorType=${info.colorType})`);
  }
  return pngs;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Failed requests (e.g. the 404 for a wrong license key) are expected; other console errors are not.
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  // Fake the server functions (/api/license and /api/translate); they have their own tests.
  const PRO_KEY = 'TEST-PRO-KEY-123';
  await page.route('**/api/license', async route => {
    const { key, device } = route.request().postDataJSON();
    const ok = key === PRO_KEY && /^[0-9a-f-]{36}$/.test(device);
    await route.fulfill({ status: ok ? 200 : 404, json: { valid: ok, message: ok ? 'Pro unlocked. Thank you!' : 'That license key was not found.' } });
  });
  let translateRequests = 0;
  await page.route('**/api/translate', async route => {
    translateRequests++;
    const body = route.request().postDataJSON();
    if (body.key !== PRO_KEY) return route.fulfill({ status: 403, json: { error: 'Pro only' } });
    const de = { 'Built for the big screen': 'Gemacht für den großen Bildschirm', 'Everything you need, side by side on iPhone Duo.': 'Alles, was du brauchst – nebeneinander auf dem iPhone Duo.',
      'Pick up where you left off': 'Mach da weiter, wo du aufgehört hast', 'Fold or unfold — your place follows you.': 'Zu- oder aufgeklappt – deine Stelle folgt dir.' };
    const translations = Object.fromEntries(body.targetLanguages.map(l => [l, body.texts.map(t => (l === 'de' && de[t]) || `[${l}] ${t}`)]));
    await route.fulfill({ json: { translations, failed: [], usage: { runs: body.targetLanguages.length, limit: 100 } } });
  });

  await page.goto(BASE + '/index.html');
  await page.waitForFunction(() => window.__dss?.ready === true, null, { timeout: 15_000 });
  check(true, 'App loaded');

  // Make a sample screenshot file using the app's own generator and save it as a fixture.
  const b64 = await page.evaluate(async () => {
    const { makeSampleScreenshot } = await import('/src/sample.js');
    const blob = await makeSampleScreenshot();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (const b of buf) s += String.fromCharCode(b); return btoa(s);
  });
  const fixture = path.join(here, 'fixtures', 'sample-screenshot.png');
  await fs.writeFile(fixture, Buffer.from(b64, 'base64'));

  // Upload two screenshots through the real file input.
  await page.setInputFiles('#fileInput', [fixture, fixture]);
  await page.waitForFunction(() => window.__dss.state.shots.length === 2);
  check(true, 'Uploaded 2 screenshots via file input');

  // Edit headline of screenshot 1
  // Edit text inline: click the headline on the inner preview, type, then Tab to the subheadline.
  await page.click('.text-hits[data-display="inner"] [data-key="headline"]');
  await page.fill('#inlineEditor', 'Your podcasts, unfolded');
  await page.keyboard.press('Tab');
  await page.fill('#inlineEditor', 'Browse and listen side by side on iPhone Duo.');
  await page.keyboard.press('Enter');
  check(await page.isHidden('#inlineEditor'), 'Inline editor closes on Enter');
  const h = await page.evaluate(() => window.__dss.state.shots[0].text.en.headline);
  check(h === 'Your podcasts, unfolded', 'Headline edit stored');

  // Try every template renders without errors
  for (const id of ['paper', 'ink', 'night', 'sage', 'mist', 'clay']) {
    await page.click(`[data-template="${id}"]`);
    await page.screenshot({ path: path.join(out, `theme-${id}.png`) });
  }
  for (const id of ['peek-left', 'peek-right', 'top', 'rise', 'drop']) {
    await page.click(`[data-layout="${id}"]`);
    await page.screenshot({ path: path.join(out, `layout-${id}.png`) });
  }
  await page.click('[data-template="paper"]');
  await page.click('[data-layout="peek-left"]');

  // Translation is Pro only: without a license the button offers Pro instead of calling the server.
  await page.click('#langBtn');
  await page.check('#langChecks input[value="de"]');
  await page.check('#langChecks input[value="ja"]');
  check((await page.textContent('#translateBtn')).includes('Get Pro'), 'Translate asks for Pro while unlicensed');
  await page.click('#translateBtn');
  check(await page.isVisible('#licensePop') && translateRequests === 0, 'Translate opens the Pro popover without calling the server');
  await page.keyboard.press('Escape');

  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(root, 'docs', 'editor.png') });

  // Free export (watermark): 1 language × 2 shots × 2 displays = 4
  const free = await exportZip(page, 'free');
  const freePngs = await verifyZip(free.zip, 'free', 4);

  // Unlock: a wrong key stays locked, the Pro key unlocks
  await page.click('#licenseBadge');
  check((await page.textContent('#buyBtn')).includes('€15.99'), 'Pro price shown');
  await page.fill('#licenseKey', 'not-a-real-key');
  await page.click('#licenseBtn');
  await page.waitForFunction(() => /not found/.test(document.getElementById('licenseStatus').textContent));
  check(!(await page.evaluate(() => window.__dss.state.licensed)), 'Invalid key stays locked');
  await page.fill('#licenseKey', PRO_KEY);
  await page.click('#licenseBtn');
  await page.waitForFunction(() => window.__dss.state.licensed === true);
  check(true, 'Pro key unlocks');
  await page.keyboard.press('Escape');

  // Translate into German and Japanese in one go
  await page.click('#langBtn');
  await page.check('#langChecks input[value="de"]');
  await page.check('#langChecks input[value="ja"]');
  await page.click('#translateBtn');
  await page.waitForFunction(() => ['de', 'ja'].every(l => window.__dss.state.langs.includes(l)));
  const deText = await page.evaluate(() => window.__dss.state.shots[1].text.de.headline);
  check(deText === 'Mach da weiter, wo du aufgehört hast', `Translation applied: "${deText}"`);
  await page.selectOption('#langSelect', 'en');
  await page.keyboard.press('Escape');

  // Pro export: 3 languages × 2 shots × 2 displays = 12, no watermark
  const pro = await exportZip(page, 'pro');
  const proPngs = await verifyZip(pro.zip, 'pro', 12);
  const freeInner = freePngs.find(n => n.includes('-inner-') && n.endsWith('01.png'));
  const proInner = proPngs.find(n => n.startsWith('en/') && n.includes('-inner-') && n.endsWith('01.png'));
  const a = await free.zip.file(freeInner).async('nodebuffer');
  const b = await pro.zip.file(proInner).async('nodebuffer');
  check(!a.equals(b), 'Watermark removed after unlock (free and pro renders differ)');
  await fs.writeFile(path.join(root, 'docs', 'sample-export.png'), b);
  const outerName = freePngs.find(n => n.includes('-outer-') && n.endsWith('01.png'));
  await fs.writeFile(path.join(root, 'docs', 'sample-export-outer-free.png'), await free.zip.file(outerName).async('nodebuffer'));
  const deInner = proPngs.find(n => n.startsWith('de/') && n.includes('-inner-') && n.endsWith('02.png'));
  await fs.writeFile(path.join(out, 'de-inner-02.png'), await pro.zip.file(deInner).async('nodebuffer'));

  // Landscape poses export Apple's landscape sizes, in both finishes.
  await page.click('.segmented[data-pose="inner"] [data-v="landscape"]');
  await page.click('.segmented[data-pose="outer"] [data-v="landscape"]');
  const finishes = await page.$$eval('#colorSwatches button', bs => bs.map(b => b.dataset.color));
  check(finishes.includes('night-sky'), `Device finishes available: ${finishes.join(', ')}`);
  await page.click(`#colorSwatches [data-color="${finishes.at(-1)}"]`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'landscape.png') });
  const land = await exportZip(page, 'landscape');
  const landPngs = await verifyZip(land.zip, 'landscape', 12);
  check(landPngs.every(n => n.includes('2853x2007') || n.includes('2034x1398')), 'Landscape export uses 2853×2007 and 2034×1398');

  check(errors.length === 0, `No page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
