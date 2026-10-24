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
const EXPECTED = { inner: [2007, 2853], outer: [1398, 2034] };
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
    const display = name.includes('-inner-') ? 'inner' : 'outer';
    const [w, h] = EXPECTED[display];
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
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // Mock translation endpoint (the real one is the Supabase function).
  await page.addInitScript(() => { window.DSS_TRANSLATE_ENDPOINT = 'https://translate.mock/functions/v1/translate'; });
  await page.route('https://translate.mock/**', async route => {
    const body = route.request().postDataJSON();
    const de = { 'Built for the big screen': 'Gemacht für den großen Bildschirm', 'Everything you need, side by side on iPhone Duo.': 'Alles, was du brauchst – nebeneinander auf dem iPhone Duo.',
      'Pick up where you left off': 'Mach da weiter, wo du aufgehört hast', 'Fold or unfold — your place follows you.': 'Zu- oder aufgeklappt – deine Stelle folgt dir.' };
    await route.fulfill({ json: { translations: body.texts.map(t => de[t] || `[${body.targetLanguage}] ${t}`) }, headers: { 'Access-Control-Allow-Origin': '*' } });
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
  await page.fill('#headline', 'Your podcasts, unfolded');
  await page.fill('#subheadline', 'Browse and listen side by side on iPhone Duo.');
  const h = await page.evaluate(() => window.__dss.state.shots[0].text.en.headline);
  check(h === 'Your podcasts, unfolded', 'Headline edit stored');

  // Try every template renders without errors
  for (const id of ['midnight', 'sunrise', 'paper', 'cobalt', 'mint']) {
    await page.click(`[data-template="${id}"]`);
    await page.screenshot({ path: path.join(out, `template-${id}.png`) });
  }
  await page.click('[data-template="midnight"]');

  // Translate (mocked endpoint)
  await page.selectOption('#translateTarget', 'de');
  await page.click('#translateBtn');
  await page.waitForFunction(() => window.__dss.state.langs.includes('de'));
  const deText = await page.evaluate(() => window.__dss.state.shots[1].text.de.headline);
  check(deText === 'Mach da weiter, wo du aufgehört hast', `Translation applied: "${deText}"`);
  await page.selectOption('#langSelect', 'en');

  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(root, 'docs', 'editor.png') });

  // Free export (watermark): 2 langs × 2 shots × 2 displays = 8
  const free = await exportZip(page, 'free');
  const freePngs = await verifyZip(free.zip, 'free', 8);

  // Unlock with dev key, export again
  await page.fill('#licenseKey', 'not-a-real-key');
  await page.click('#licenseBtn');
  check(!(await page.evaluate(() => window.__dss.state.licensed)), 'Invalid key stays locked');
  await page.fill('#licenseKey', 'DUO-DEV-UNLOCK');
  await page.click('#licenseBtn');
  await page.waitForFunction(() => window.__dss.state.licensed === true);
  check(true, 'Dev license key unlocks');
  const pro = await exportZip(page, 'pro');
  const proPngs = await verifyZip(pro.zip, 'pro', 8);

  const innerName = proPngs.find(n => n.startsWith('en/') && n.includes('-inner-') && n.endsWith('01.png'));
  const a = await free.zip.file(innerName).async('nodebuffer');
  const b = await pro.zip.file(innerName).async('nodebuffer');
  check(!a.equals(b), 'Watermark removed after unlock (free and pro renders differ)');
  await fs.writeFile(path.join(root, 'docs', 'sample-export.png'), b);
  const outerName = freePngs.find(n => n.startsWith('en/') && n.includes('-outer-') && n.endsWith('01.png'));
  await fs.writeFile(path.join(root, 'docs', 'sample-export-outer-free.png'), await free.zip.file(outerName).async('nodebuffer'));
  const deInner = freePngs.find(n => n.startsWith('de/') && n.includes('-inner-') && n.endsWith('02.png'));
  await fs.writeFile(path.join(out, 'de-inner-02.png'), await free.zip.file(deInner).async('nodebuffer'));

  check(errors.length === 0, `No page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
