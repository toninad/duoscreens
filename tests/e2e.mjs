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
// Apple's App Store sizes per folder, portrait and landscape.
const VALID = {
  'iPhone-Duo-inner': ['2007x2853', '2853x2007'], 'iPhone-Duo-outer': ['1398x2034', '2034x1398'],
  'iPhone-18-Pro-Max': ['1320x2868', '2868x1320'], 'iPhone-Air': ['1260x2736', '2736x1260'], 'iPhone-18-Pro': ['1206x2622', '2622x1206'],
};
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
    const [, device, folder] = name.match(/(iPhone-[\w-]+?)-(\d+x\d+)\//);
    const [w, h] = folder.split('x').map(Number);
    check(VALID[device]?.includes(folder), `${label}: ${folder} is an App Store size for ${device}`);
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

  // First launch: pick a device first. Free picks one at a time: choosing iPhone replaces the Duo.
  await page.waitForSelector('#deviceDialog[open]');
  check(true, 'First launch opens the device picker');
  await page.click('.tile[data-family="iphone"] .tile-select');
  await page.waitForFunction(() => window.__dss.state.devices.join() === 'iphone-18-pro-max');
  check(true, 'Free: picking iPhone replaces the Duo');
  await page.click('.tile[data-family="duo"] .tile-select');
  await page.waitForFunction(() => window.__dss.state.devices.join() === 'duo');
  check(true, 'Free: one device at a time');
  await page.click('#deviceDone');
  check(await page.$$eval('.shot-card .screen-add', bs => bs.length) === 2, 'The board starts with an empty card: an "add screenshot" screen per frame');

  // Make a sample screenshot file using the app's own generator and save it as a fixture.
  const b64 = await page.evaluate(async () => {
    const { makeSampleScreenshot } = await import('/src/sample.js');
    const blob = await makeSampleScreenshot();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (const b of buf) s += String.fromCharCode(b); return btoa(s);
  });
  const fixture = path.join(here, 'fixtures', 'sample-screenshot.png');
  await fs.writeFile(fixture, Buffer.from(b64, 'base64'));

  // Every screen takes its own capture. Bulk-added captures go to the screen whose shape they match:
  // the generated sample (2007 × 2853) to the inner display, the cover capture to the outer.
  await page.setInputFiles('#fileInput', [fixture, fixture]);
  await page.waitForFunction(() => window.__dss.state.shots.length === 2);
  check(await page.evaluate(() => window.__dss.state.shots.every(s => Object.keys(s.images).join() === 'duo/inner')), 'Inner-shaped captures fill the inner display of each card');
  const cover = path.join(root, 'samples', 'outer-portrait-home.webp');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.shot-card:first-child .frame[data-display="outer"] .screen-add')]);
  await chooser.setFiles(cover);
  await page.waitForFunction(() => window.__dss.state.shots[0].images['duo/outer']);
  check(true, 'Clicking an empty screen adds a capture to just that frame');
  await page.setInputFiles('#fileInput', [cover]);
  await page.waitForFunction(() => window.__dss.state.shots[1].images['duo/outer']);
  check(await page.$$eval('.shot-card .screen-add', bs => bs.length) === 0, 'Uploaded captures for both displays of 2 screenshots');

  // Edit headline of screenshot 1
  // Edit text inline: click the headline on the inner preview, type, then Tab to the subheadline.
  check(await page.evaluate(() => window.__dss.state.style.layout === 'top') && await page.getAttribute('[data-layout="top"]', 'aria-pressed') === 'true', 'Text-above layout is the preselected default');
  await page.click('.lang-row[data-lang="en"] .shot-card:first-child .frame[data-display="inner"] [data-key="headline"]');
  await page.fill('#inlineEditor', 'Your podcasts, unfolded');
  await page.keyboard.press('Tab');
  await page.fill('#inlineEditor', 'Browse and listen side by side on iPhone Duo.');
  await page.keyboard.press('Enter');
  check(await page.isHidden('#inlineEditor'), 'Inline editor closes on Enter');
  const h = await page.evaluate(() => window.__dss.state.shots[0].text.en.headline);
  check(h === 'Your podcasts, unfolded', 'Headline edit stored');
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => window.__dss.state.selection.size === 0), 'Escape clears the selection');

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
  await page.keyboard.press('Escape');
  check(await page.$$eval('.lang-row', rs => rs.map(r => r.dataset.lang).join()) === 'en,de,ja', 'Board shows a row per language');

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
  await page.click('#devicesBtn');
  await page.click('.segmented[data-pose="duo/inner"] [data-v="landscape"]');
  await page.click('.segmented[data-pose="duo/outer"] [data-v="landscape"]');
  const finishes = await page.$$eval('.swatches[data-device="duo"] button', bs => bs.map(b => b.dataset.color));
  check(finishes.includes('night-sky'), `Device finishes available: ${finishes.join(', ')}`);
  await page.click(`.swatches[data-device="duo"] [data-color="${finishes.at(-1)}"]`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'landscape.png') });
  const land = await exportZip(page, 'landscape');
  const landPngs = await verifyZip(land.zip, 'landscape', 12);
  check(landPngs.every(n => n.includes('2853x2007') || n.includes('2034x1398')), 'Landscape export uses 2853×2007 and 2034×1398');

  // iPhone: tick it, then pick one model. Its size joins the Duo's on every screenshot, in every language.
  await page.click('#devicesBtn');
  await page.click('.tile[data-family="iphone"] .tile-select');
  await page.waitForSelector('[data-model="iphone-18-pro-max"]');
  check(await page.getAttribute('[data-model="iphone-18-pro-max"]', 'aria-checked') === 'true', 'iPhone starts on the 18 Pro Max');
  await page.click('[data-model="iphone-air"]');
  await page.click('.swatches[data-device="iphone-air"] [data-color="sky-blue"]');
  await page.waitForFunction(() => window.__dss.state.colors['iphone-air'] === 'sky-blue' && window.__dss.state.devices.join() === 'duo,iphone-air');
  await page.screenshot({ path: path.join(out, 'device-picker.png') });
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => window.__dss.state.devices.join()) === 'duo,iphone-air', 'One iPhone model at a time');
  check(!(await page.$('.segmented[data-pose="iphone-air/main"]')), 'iPhones have no orientation choice: always portrait');
  check(await page.$$eval('.lang-row[data-lang="en"] .shot-card:first-child .frame', fs => fs.length) === 3, 'A card shows a frame per App Store size');
  const half = await exportZip(page, 'devices-half');
  check(Object.keys(half.zip.files).filter(n => n.endsWith('.png')).length === 12, 'Empty iPhone screens are left out of the export');
  for (const n of [1, 2]) {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(`.lang-row[data-lang="en"] .shot-card:nth-child(${n}) .frame[data-target="iphone-air/main"] .screen-add`)]);
    await fc.setFiles(fixture);
  }
  await page.waitForFunction(() => window.__dss.state.shots.every(s => s.images.iphone));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'devices.png') });
  const all = await exportZip(page, 'devices');
  const allPngs = await verifyZip(all.zip, 'devices', 18);
  const air = allPngs.find(n => n.startsWith('en/iPhone-Air-1260x2736/01'));
  check(!!air, 'iPhone Air export is 1260×2736');
  if (air) await fs.writeFile(path.join(out, 'iphone-air-01.png'), await all.zip.file(air).async('nodebuffer'));

  // Variations: duplicate the second screenshot, restyle only the copy.
  await page.click('.lang-row[data-lang="en"] .shot-card:nth-child(2) .card-num');
  await page.click('.lang-row[data-lang="en"] .shot-card:nth-child(2) [data-a="dup"]');
  await page.waitForFunction(() => window.__dss.state.shots.length === 3);
  check((await page.textContent('#scopeLabel')).includes('3'), 'The copy is selected and the dock scopes to it');
  await page.click('[data-template="ink"]');
  const styles = await page.evaluate(() => window.__dss.state.shots.map(s => s.style?.bg1 || 'base'));
  check(styles[0] === 'base' && styles[1] === 'base' && styles[2] !== 'base', 'Theme applies to the selected variation only');
  check(await page.$$eval('.lang-row[data-lang="de"] .shot-card', cs => cs.length) === 3, 'Variation appears in every language row');
  await page.click('#zoomFit');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, 'board.png') });

  // Back from Polar checkout: the app claims the key itself (first answer: still being created).
  let claims = 0;
  await page.route('**/api/claim', async route => {
    claims++;
    const { checkoutId } = route.request().postDataJSON();
    if (claims === 1) return route.fulfill({ status: 202, json: { pending: true, message: 'Your license key is being created.' } });
    await route.fulfill({ json: { valid: checkoutId === '11111111-2222-3333-4444-555555555555', key: PRO_KEY, message: 'Pro unlocked. Thank you!' } });
  });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + '/index.html?checkout=success&checkout_id=11111111-2222-3333-4444-555555555555');
  await page.waitForFunction(() => window.__dss?.state.licensed === true, null, { timeout: 15_000 });
  check(claims === 2 && await page.isVisible('#proWelcome') && (await page.inputValue('#welcomeKey')) === PRO_KEY, 'Checkout return unlocks Pro and shows the key in a centred welcome');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'welcome.png') });
  await page.click('#welcomeDone');
  check(!(await page.isVisible('#proWelcome')), 'Welcome closes');
  await page.click('#licenseBadge');
  check(await page.isVisible('#licenseActive') && (await page.textContent('#activeKey')).startsWith(PRO_KEY.slice(0, 8)), 'License popover shows Pro active with the key');
  await page.keyboard.press('Escape');
  check(!(await page.evaluate(() => location.search)), 'Checkout parameters are removed from the address');

  check(errors.length === 0, `No page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
