/* global Konva, JSZip */
import { PRO, WATERMARK_TEXT, LANGUAGES } from './config.js';
import { FAMILIES, DEVICES, TARGETS, SCREENS, targetById, deviceById, loadFrame, availableFinishes, getFrame } from './devices.js';
import { TEMPLATES, LAYOUTS, FONTS, templateById } from './templates.js';
import { buildComposition } from './render.js';
import { canvasToRgbPng } from './png.js';
import { checkLicense, claimCheckout, storedLicenseKey, forgetLicense } from './license.js';
import { translateTexts } from './translate.js';
import { makeSampleScreenshot, SAMPLE_SHOTS } from './sample.js';
import { openStore, boards as boardStore, meta as metaStore, cleanupImages, askPersistence, imageHashesOf } from './store.js';
import { prepareImage, imageFromHash, hashOf, blobForHash, storeVerified } from './images.js';
import { createSync } from './sync.js';

const $ = (id) => document.getElementById(id);
const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = { del: svg('M5 5l6 6M11 5l-6 6') };
// A target is one App Store size: a device display such as "duo/inner" or "iphone-air/main".
const activeTargets = () => TARGETS.filter(t => state.devices.includes(t.device.id));
const targetsOfDevice = (id) => TARGETS.filter(t => t.device.id === id);
const MAX_SHOTS = 10;   // App Store Connect takes up to 10 screenshots per size
const groupOf = (shotId) => state.groups.find(g => g.shots.some(s => s.id === shotId));
// A screenshot card is one screen: one of its device's displays (the Duo's inner or outer) in an orientation.
// The display a new card starts on: the device's startOn display (the Duo's cover screen), else its first.
const firstTarget = (deviceId) => {
  const ts = targetsOfDevice(deviceId);
  return ts.find(t => t.display.id === t.device.startOn) || ts[0];
};
const targetOf = (shot) => targetById(shot.target) || firstTarget(groupOf(shot.id)?.device);
const targetsOf = (shot) => [targetOf(shot)];
const countOn = (group, tid) => group.shots.filter(s => targetOf(s).id === tid).length;   // per App Store size, max 10
// Each card has its own orientation (iPhones are always portrait).
const poseOf = (shot) => (!shot || targetOf(shot).display.poses?.length === 1 ? 'portrait' : shot.pose || 'portrait');
const sizeOf = (tid, shot) => targetById(tid).display.size[poseOf(shot)];
const targetLabel = (t) => t.display.label ? `${t.device.name} · ${t.display.label}` : t.device.name;

const state = {
  // The board: a group per device, each with up to 10 screenshots.
  // shot = { id, target, pose, images: { [screen]: img }, style?: overrides, edited?,
  //          text: { [lang]: { [screen]: { headline, subheadline } } } }: every screen has its own words
  groups: [],           // { id, device, shots: [shot] }
  get shots() { return this.groups.flatMap(g => g.shots); },
  get devices() { return this.groups.map(g => g.device); },
  selection: new Set(), // shot ids; empty means "all screenshots" for toolbar edits
  baseLang: 'en',
  langs: ['en'],
  style: null,
  licensed: false,
  models: {},           // family id -> the model last picked in the device picker
  colors: {},           // device id -> finish id
  available: {},        // device id -> finishes that have frame files
};
let nextId = 1;

// ---------- Style: shared defaults plus per-screenshot overrides (variations) ----------
const styleOf = (shot) => ({ ...state.style, ...(shot?.style || {}) });
const selectedShots = () => state.shots.filter(s => state.selection.has(s.id));

/** The style the toolbar shows: the selected screenshot's, or the shared one. */
function activeStyle() {
  const sel = selectedShots();
  return sel.length ? styleOf(sel[0]) : state.style;
}

/** Toolbar edits apply to the selected screenshots, or to all of them when nothing is selected. */
function applyStyle(patch) {
  const sel = selectedShots();
  if (sel.length) for (const s of sel) s.style = { ...(s.style || {}), ...patch };
  else {
    Object.assign(state.style, patch);
    for (const s of state.shots) if (s.style) for (const k of Object.keys(patch)) delete s.style[k];
  }
  syncToolbar();
  renderBoard();
}

const themePatch = (t) => ({ template: t, bg1: t.bg1, bg2: t.bg2, textColor: t.textColor, font: t.font });

function setTemplate(id) { applyStyle(themePatch(templateById(id))); }

function syncToolbar() {
  renderTemplateGrid();
  renderLayoutGrid();
  syncStyleInputs();
  const sel = selectedShots();
  $('scopeLabel').textContent = !sel.length ? 'All screenshots'
    : sel.length === 1 ? `${deviceById(groupOf(sel[0].id).device).name} ${groupOf(sel[0].id).shots.indexOf(sel[0]) + 1}` : `${sel.length} selected`;
  $('scopeLabel').classList.toggle('on', sel.length > 0);
}


// ---------- UI: templates ----------
function renderTemplateGrid() {
  const grid = $('templateGrid');
  grid.innerHTML = '';
  for (const t of TEMPLATES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = t.name;
    b.dataset.template = t.id;
    const st = activeStyle();
    b.setAttribute('aria-pressed', String(st.bg1.toLowerCase() === t.bg1.toLowerCase() && st.bg2.toLowerCase() === t.bg2.toLowerCase()));
    b.style.background = `linear-gradient(${t.bg1}, ${t.bg2})`;
    b.style.color = t.textColor;
    const fam = FONTS[t.font].family;
    b.style.fontFamily = fam.includes(',') ? fam : `"${fam}"`;   // quoted: a name ending in a number is invalid CSS unquoted
    b.style.fontWeight = FONTS[t.font].headlineStyle;
    b.innerHTML = `<span class="aa">Aa</span><span class="name"></span>`;
    b.querySelector('.name').textContent = t.name;
    b.onclick = () => setTemplate(t.id);
    grid.appendChild(b);
  }
  // Custom: shows the current colour once it's not one of the presets.
  const st = activeStyle(), custom = $('customBg');
  const isCustom = !grid.querySelector('[aria-pressed=true]');
  custom.setAttribute('aria-pressed', String(isCustom));
  custom.style.setProperty('--custom', isCustom ? `linear-gradient(${st.bg1}, ${st.bg2})` : '');
}

// Little diagrams of each layout: canvas, device and text lines.
const LAYOUT_ICONS = {
  'peek-left':  '<rect x="-10" y="5" width="30" height="22" rx="4" class="dev"/><path d="M26 13h10M26 17h8M26 21h6" class="txt"/>',
  'peek-right': '<rect x="20" y="5" width="30" height="22" rx="4" class="dev"/><path d="M4 13h10M4 17h8M4 21h6" class="txt"/>',
  'top':        '<path d="M12 7h16M14 11h12" class="txt"/><rect x="9" y="15" width="22" height="13" rx="3" class="dev"/>',
  'rise':       '<path d="M12 6h16M14 10h12" class="txt"/><rect x="6" y="14" width="28" height="22" rx="4" class="dev"/>',
  'drop':       '<rect x="6" y="-8" width="28" height="22" rx="4" class="dev"/><path d="M12 21h16M14 25h12" class="txt"/>',
};
function renderLayoutGrid() {
  const grid = $('layoutGrid');
  grid.innerHTML = '';
  for (const l of LAYOUTS) {
    const b = document.createElement('button');
    b.type = 'button'; b.title = l.name; b.dataset.layout = l.id;
    b.setAttribute('aria-label', l.name);
    b.setAttribute('aria-pressed', String(activeStyle().layout === l.id));
    b.innerHTML = `<svg viewBox="0 0 40 32" aria-hidden="true">${LAYOUT_ICONS[l.id]}</svg>`;
    b.onclick = () => applyStyle({ layout: l.id });
    grid.appendChild(b);
  }
}

function syncStyleInputs() {
  const st = activeStyle();
  $('bg1').value = st.bg1;
  $('bg2').value = st.bg2;
  $('textColor').value = st.textColor;
  $('bgHex').value = st.bg1.toUpperCase();
  $('textHex').value = st.textColor.toUpperCase();
  $('bg2').parentElement.style.setProperty('--chip', st.bg2);
  for (const b of document.querySelectorAll('#bgSwatches button')) b.setAttribute('aria-pressed', String(b.dataset.c.toLowerCase() === st.bg1.toLowerCase()));
  for (const b of document.querySelectorAll('#textSwatches button')) b.setAttribute('aria-pressed', String(b.dataset.c.toLowerCase() === st.textColor.toLowerCase()));
  $('fontSelect').value = st.font;
  $('sizeLabel').textContent = `${Math.round((st.headlineScale || 1) * 100)}%`;
  $('textBtn').style.setProperty('--text', st.textColor);
}

// ---------- Text ----------
// The words on one screen. Falls back to the base language (until translated), then to another
// screen's words (after switching a group to a device with different screens).
function textFor(shot, lang, screen) {
  const any = (t) => t && (t[screen] || Object.values(t)[0]);
  return shot.text[lang]?.[screen] || shot.text[state.baseLang]?.[screen] || any(shot.text[lang]) || any(shot.text[state.baseLang])
    || { headline: '', subheadline: '' };
}
const screensOf = (shot) => [...new Set(targetsOf(shot).map(t => t.display.screen))];
const sameText = (screens, t) => Object.fromEntries(screens.map(sc => [sc, { ...t }]));

// The capture on a screen, or null while it still shows the "add screenshot" placeholder.
const imageFor = (shot, screen) => shot.images?.[screen] || null;
const hasAnyImage = (shot) => !!imageFor(shot, targetOf(shot).display.screen);

function compositionProps(shot, tid, lang) {
  const t = textFor(shot, lang, targetById(tid).display.screen);
  const target = targetById(tid), pose = poseOf(shot);
  return {
    image: imageFor(shot, target.display.screen, pose),
    frame: getFrame(target.device.id, state.colors[target.device.id], target.display.id, pose),
    headline: t.headline, subheadline: t.subheadline,
    style: styleOf(shot), watermark: !state.licensed, watermarkText: WATERMARK_TEXT,
  };
}

// ---------- Board ----------
// One canvas for everything: a row per language, a card per screenshot (a frame per App Store size),
// pan with scroll or drag, zoom with pinch or ⌘ + scroll. Frames are drawn at board scale K and
// re-rasterized at the current zoom so text stays sharp.
const K = 440 / 2853;                 // board units per export pixel: an inner portrait frame is 440 units tall
const view = { x: 0, y: 0, z: 1 };
const frames = new Map();             // `${shotId}:${lang}:${target}` -> { stage, layer, el, shotId, lang, target, nodes, hits }
let structureKey = '';
// What the canvas shows: one device (group) in one language, or every language with "Compare all".
const focus = { group: null, lang: null, compare: false };
const focusedGroup = () => state.groups.find(g => g.id === focus.group) || state.groups[0];
const focusedLang = () => (state.langs.includes(focus.lang) ? focus.lang : state.baseLang);
function setFocus(patch) {
  Object.assign(focus, patch);
  if (patch.group != null) state.selection.clear();
  if (editing) stopEditing();
  refresh({ fit: true });
}
let editing = null;                   // { shotId, lang, target, key }

const pad2 = (n) => String(n).padStart(2, '0');
const el = (tag, cls, html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; e.innerHTML = html; return e; };
const PLUS = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>';
const ICON = {
  dup: svg('M5.5 5.5V4a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 13.5 4v5A1.5 1.5 0 0 1 12 10.5h-1.5M4 5.5h5A1.5 1.5 0 0 1 10.5 7v5A1.5 1.5 0 0 1 9 13.5H4A1.5 1.5 0 0 1 2.5 12V7A1.5 1.5 0 0 1 4 5.5z'),
  left: svg('M10 4l-4 4 4 4'), right: svg('M6 4l4 4-4 4'), del: svg('M5 5l6 6M11 5l-6 6'),
  more: svg('M4 8h.01M8 8h.01M12 8h.01'),
  check: svg('M3.5 8.5l3 3 6-7'),
};

let moveTimer;
function applyView() {
  const world = $('boardWorld');
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  world.classList.add('moving');
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => world.classList.remove('moving'), 160);
  // Labels and controls on the board are counter-scaled, so they stay the same size on screen at any
  // zoom (like Figma's frame names); only the screenshots grow and shrink.
  world.style.setProperty('--ui', String(1 / view.z));
  // Zoomed far out, captions would run into each other: keep only the number, then nothing.
  world.classList.toggle('far', view.z < 0.45);
  world.classList.toggle('farther', view.z < 0.22);
  // Dots every 24 board pixels; when zoomed out far they'd crowd, so skip to every 2nd, 4th…
  let grid = 24 * view.z;
  while (grid < 14) grid *= 2;
  const board = $('board');
  board.style.setProperty('--grid', `${grid}px`);
  board.style.setProperty('--grid-x', `${view.x % grid}px`);
  board.style.setProperty('--grid-y', `${view.y % grid}px`);
  $('zoomLabel').textContent = `${Math.round(view.z * 100)}%`;
  schedulePixelRatio();
}

let prTimer;
// Frames on screen redraw at the real zoom (up to the export's own resolution), so zooming in
// stays sharp; frames off screen stay light so a big board doesn't eat memory.
function schedulePixelRatio() {
  clearTimeout(prTimer);
  prTimer = setTimeout(() => {
    const dpr = window.devicePixelRatio || 1;
    const full = Math.min(1 / K, view.z * dpr);
    const light = Math.min(full, 2);
    const vw = innerWidth, vh = innerHeight;
    for (const f of frames.values()) {
      const r = f.el.getBoundingClientRect();
      const onScreen = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
      const pr = Math.max(1, Math.round((onScreen ? full : light) * 4) / 4);
      if (f.pr === pr) continue;
      f.layer.getCanvas().setPixelRatio(pr);
      f.pr = pr;
      f.layer.batchDraw();
    }
  }, 120);
}

function zoomAt(cx, cy, factor) {
  const r = $('board').getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  const z = Math.min(4, Math.max(0.08, view.z * factor));
  const k = z / view.z;
  view.x = px - (px - view.x) * k;
  view.y = py - (py - view.y) * k;
  view.z = z;
  applyView();
}

function zoomBy(factor) {
  const r = $('board').getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}

/** Fits every row and card on screen, leaving room for the floating bars. */
function fitBoard() {
  const world = $('boardWorld'), board = $('board');
  if (!world.offsetWidth || !world.offsetHeight) return;
  const narrow = matchMedia('(max-width: 860px)').matches;
  const top = narrow ? 118 : 100, bottom = narrow ? 92 : 104, side = narrow ? 16 : 48;
  // Names above, captions below and the round + beside the cards keep their screen size outside
  // the measured layout, so leave room for them.
  const panelW = narrow ? 0 : 256;   // the floating side panel
  const plusW = narrow ? 0 : 70, langW = focus.compare && state.langs.length > 1 && !narrow ? 100 : 0, nameH = 40, capH = narrow ? 90 : 30;
  const bw = board.clientWidth - side * 2 - plusW - langW - panelW, bh = board.clientHeight - top - bottom - nameH - capH;
  // The board's labels keep their screen size, so the world's size depends on the zoom: settle it.
  let w, h;
  for (let i = 0; i < 4; i++) {
    w = world.offsetWidth; h = world.offsetHeight;
    // Phones stack the cards in one column, so fit the width and let people pan down.
    view.z = Math.min(1, Math.max(0.08, narrow ? bw / w : Math.min(bw / w, bh / h)));
    world.style.setProperty('--ui', String(1 / view.z));
    // Gaps between rows and groups are sized for this zoom (room for names and captions); zooming
    // afterwards leaves them alone, so nothing moves while you zoom.
    world.style.setProperty('--fit-ui', String(1 / view.z));
  }
  view.x = side + panelW + langW + (bw - w * view.z) / 2;
  view.y = top + nameH + Math.max(0, (bh - h * view.z) / 2);
  applyView();
}

function buildStructure() {
  for (const f of frames.values()) f.stage.destroy();
  frames.clear();
  const world = $('boardWorld');
  world.innerHTML = '';
  const group = focusedGroup();
  const langs = focus.compare && state.langs.length > 1 ? state.langs : [focusedLang()];
  if (group) {
    const device = deviceById(group.device);
    const targets = targetsOfDevice(group.device);
    const section = el('section', 'group');
    section.dataset.device = group.device;
    section.appendChild(groupHead(group, device));
    for (const lang of langs) {
      const row = el('div', 'lang-row');
      row.dataset.lang = lang;
      const head = el('header', 'row-head', '<span class="row-name"></span>');
      head.querySelector('.row-name').textContent = langName(lang);
      if (lang !== state.baseLang) {
        const rm = el('button', 'row-remove', ICON.del);
        rm.type = 'button'; rm.title = `Remove ${langName(lang)}`; rm.setAttribute('aria-label', rm.title);
        rm.onclick = () => removeLang(lang);
        head.appendChild(rm);
      }
      const cards = el('div', 'row-shots');
      group.shots.forEach((shot, i) => {
        const card = el('article', 'shot-card');
        card.dataset.id = shot.id;
        // Quiet by default: just the frame and one caption line. Selecting a card swaps the caption for
        // one small toolbar: its display and orientation, then move, duplicate and remove.
        card.innerHTML = '<div class="card-frames"></div>';
        const tools = el('div', 'card-acts', `
            <button type="button" data-a="left" title="Move left" aria-label="Move left" ${i === 0 ? 'disabled' : ''}>${ICON.left}</button>
            <button type="button" data-a="right" title="Move right" aria-label="Move right" ${i === group.shots.length - 1 ? 'disabled' : ''}>${ICON.right}</button>
            <button type="button" data-a="dup" title="Duplicate as a variation" aria-label="Duplicate" ${countOn(group, targetOf(shot).id) >= MAX_SHOTS ? 'disabled' : ''}>${ICON.dup}</button>
            <button type="button" class="del" data-a="del" title="Remove" aria-label="Remove">${ICON.del}</button>`);
        tools.onclick = (e) => {
          const a = e.target.closest('button')?.dataset.a;
          if (a === 'dup') duplicateShot(shot.id);
          else if (a === 'left') moveShot(shot.id, -1);
          else if (a === 'right') moveShot(shot.id, 1);
          else if (a === 'del') deleteShot(shot.id);
        };
        // Which display and orientation this card is (the Duo has two displays; iPhones are always portrait).
        const poseBox = el('div', 'card-pose-pill');
        for (const t of targets) {
          const poses = t.display.poses || ['portrait', 'landscape'];
          if (targets.length < 2 && poses.length < 2) continue;   // iPhones: one display, always portrait
          const seg = el('div', 'segmented');
          seg.dataset.pose = t.id;
          seg.setAttribute('role', 'group');
          seg.setAttribute('aria-label', `${t.display.label} display`);
          const full = t.id !== targetOf(shot).id && countOn(group, t.id) >= MAX_SHOTS;
          for (const v of poses) {
            const b = el('button', '', SCREEN_ICON[`${t.display.id}-${v}`] || POSE_ICON[v]);
            b.type = 'button'; b.dataset.v = v; b.setAttribute('aria-label', `${t.display.label} ${v}`);
            b.title = full ? `${t.display.label} has its ${MAX_SHOTS} screenshots` : `${t.display.label}, ${v}: ${t.display.size[v].width} × ${t.display.size[v].height}`;
            b.disabled = full;
            b.setAttribute('aria-pressed', String(targetOf(shot).id === t.id && poseOf(shot) === v));
            b.onclick = (e) => { e.stopPropagation(); shot.target = t.id; shot.pose = v; renderBoard(); };
            seg.appendChild(b);
          }
          poseBox.append(seg);
        }
        const framesEl = card.querySelector('.card-frames');
        for (const t of targetsOf(shot)) {
          const size = sizeOf(t.id, shot);
          const fr = el('div', 'frame', '<div class="frame-stage"></div><div class="text-hits"></div>');
          fr.dataset.target = t.id;
          if (t.device.id === 'duo') fr.dataset.display = t.display.id;
          // Drop a capture on a frame to put it on that screen.
          fr.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); fr.classList.add('drop'); });
          fr.addEventListener('dragleave', () => fr.classList.remove('drop'));
          fr.addEventListener('drop', (e) => {
            e.preventDefault(); e.stopPropagation(); fr.classList.remove('drop');
            setScreenImage(shot.id, t.display.screen, e.dataTransfer.files[0]);
          });
          fr.style.width = `${Math.round(size.width * K)}px`;
          fr.style.height = `${Math.round(size.height * K)}px`;
          // On the board the screenshot is rounded like the display it's for (exports stay square):
          // the screen's corner radii scaled to the card, per corner, so the Duo's outer display keeps
          // its square hinge side.
          const geo = getFrame(t.device.id, state.colors[t.device.id], t.display.id, poseOf(shot))?.geo;
          if (geo?.radii) {
            const k = size.width * K / geo.screen.w;
            fr.style.borderRadius = geo.radii.map(r => `${(r * k).toFixed(1)}px`).join(' ');
          }
          const wrap = el('figure', 'frame-wrap');
          wrap.appendChild(fr);
          const cap = el('figcaption', 'frame-cap', `<span class="card-num">${pad2(i + 1)}</span><span class="cap-text"></span><span class="card-tag"></span>`);
          if (lang === state.baseLang) cap.querySelector('.cap-text').textContent = `${t.display.label ? t.display.label + ' · ' : ''}${size.width} × ${size.height}`;
          wrap.append(cap);
          poseBox.appendChild(tools);
          const pose = el('div', 'card-pose');   // floats where the caption is, only while selected
          pose.appendChild(poseBox);
          wrap.style.setProperty('--fh', fr.style.height);
          wrap.appendChild(pose);
          framesEl.appendChild(wrap);
          const stage = new Konva.Stage({ container: fr.firstChild, width: Math.round(size.width * K), height: Math.round(size.height * K) });
          const layer = new Konva.Layer({ listening: false });
          layer.scale({ x: K, y: K });
          stage.add(layer);
          frames.set(`${shot.id}:${lang}:${t.id}`, { stage, layer, el: fr, shotId: shot.id, lang, target: t.id, pr: 0 });
        }
        cards.appendChild(card);
      });
      if (lang === state.baseLang && targets.some(t => countOn(group, t.id) < MAX_SHOTS)) {   // another screen of this device
        // A round "+" after the last screen; the new card starts like the one before it.
        const add = el('button', 'add-screen', PLUS);
        add.type = 'button';
        add.title = `Add ${device.family === 'iphone' ? 'an iPhone' : `a ${device.short || device.name}`} screen`;
        add.setAttribute('aria-label', add.title);
        add.onclick = () => { group.shots.push(newShot(group)); refresh({ fit: true }); };
        cards.appendChild(add);
      }
      if (langs.length > 1) row.append(head);   // language labels only when comparing
      row.append(cards);
      section.appendChild(row);
    }
    world.appendChild(section);
  }
  schedulePixelRatio();
}

// Languages with a translation in flight; their side-panel rows show a skeleton shimmer.
const translating = new Set();
function markTranslating(b, lang) {
  b.classList.add('side-loading');
  b.style.setProperty('--d', `${(0.12 * [...translating].indexOf(lang) - 1.5).toFixed(2)}s`);   // lower rows trail a little: a ripple down the list
  b.setAttribute('aria-busy', 'true');
  b.title = `Translating into ${b.querySelector('.side-name').textContent}…`;
  b.querySelector('.side-meta').replaceChildren(el('span', 'side-skel'));
}

// The floating panel on the left: which device and which language the canvas shows.
function renderSidePanel() {
  const nav = $('deviceNav'), langNav = $('langNav');
  nav.innerHTML = ''; langNav.innerHTML = '';
  $('sidePanel').classList.add('ready');
  const row = (label, meta, current, onclick, cls = '') => {
    const b = el('button', `side-row ${cls}`, '<span class="side-name"></span><span class="side-meta"></span>');
    b.type = 'button';
    b.querySelector('.side-name').textContent = label;
    b.querySelector('.side-meta').textContent = meta;
    if (current) b.setAttribute('aria-current', 'true');
    b.onclick = onclick;
    return b;
  };
  const g0 = focusedGroup();
  for (const g of state.groups) {
    const d = deviceById(g.device);
    const b = row(d.family === 'iphone' ? 'iPhone' : d.name, String(g.shots.length), g === g0, () => setFocus({ group: g.id }));
    b.dataset.group = g.id; b.dataset.device = g.device;
    nav.appendChild(b);
  }
  const add = el('button', 'side-row side-add add-group', `${PLUS}<span>Add device</span>${state.licensed ? '' : '<span class="pro-tag">Pro</span>'}`);
  add.type = 'button';
  add.onclick = () => (state.licensed ? openDeviceDialog('add') : $('licensePop').showPopover());
  nav.appendChild(add);

  const cur = focusedLang();
  for (const lang of state.langs) {
    const b = row(langName(lang), lang === state.baseLang ? 'Original' : '', !focus.compare && lang === cur, () => setFocus({ lang, compare: false }));
    b.dataset.lang = lang;
    if (lang !== state.baseLang) {
      const rm = el('span', 'side-remove', ICON.del);
      rm.setAttribute('role', 'button'); rm.tabIndex = 0;
      rm.title = `Remove ${langName(lang)}`; rm.setAttribute('aria-label', rm.title);
      rm.onclick = (e) => { e.stopPropagation(); removeLang(lang); };
      b.appendChild(rm);
    }
    if (translating.has(lang)) markTranslating(b, lang);
    langNav.appendChild(b);
  }
  // Languages still on their way in: a placeholder row each, shimmering until the translation lands.
  for (const lang of translating) {
    if (state.langs.includes(lang)) continue;
    const b = row(langName(lang), '', false, null);
    b.disabled = true;
    markTranslating(b, lang);
    langNav.appendChild(b);
  }
  if (state.langs.length > 1) {
    const cmp = row('Compare all', '', focus.compare, () => setFocus({ compare: !focus.compare }), 'side-compare');
    cmp.setAttribute('aria-pressed', String(focus.compare));
    langNav.appendChild(cmp);
  }
  const tr = el('button', 'side-row side-add', `${PLUS}<span>Add languages</span>${state.licensed ? '' : '<span class="pro-tag">Pro</span>'}`);
  tr.type = 'button';
  tr.onclick = () => openLangPicker(tr);
  langNav.appendChild(tr);
}

// A group's header: the device, how many of its 10 App Store slots are used, its finish and (Duo)
// orientation, and switching or removing it.
function groupHead(group, device) {
  const head = el('header', 'group-head');
  const title = el('div', 'group-title', '<h2></h2><span class="group-count"></span>');
  title.querySelector('h2').textContent = device.family === 'iphone' ? 'iPhone' : device.name;
  const targets = targetsOfDevice(device.id);
  title.querySelector('.group-count').textContent = targets.length > 1
    ? targets.map(t => `${countOn(group, t.id)} ${t.display.label.toLowerCase()}`).join(' · ')
    : `${group.shots.length} of ${MAX_SHOTS}`;
  if (state.langs.length > 1 && !focus.compare) title.querySelector('.group-count').textContent += ` · ${langName(focusedLang())}`;
  // Everything else about the group lives in one quiet menu, so the header stays a label.
  const more = el('button', 'group-btn icon group-more', ICON.more);
  more.type = 'button'; more.title = `${device.name} options`; more.setAttribute('aria-label', more.title);
  more.onclick = () => openGroupMenu(group, more);
  const tools = el('div', 'group-tools');
  tools.appendChild(more);
  head.append(title, tools);
  return head;
}

function syncSelectionUI() {
  for (const card of document.querySelectorAll('.shot-card')) {
    const shot = state.shots.find(s => s.id === +card.dataset.id);
    card.classList.toggle('selected', state.selection.has(+card.dataset.id));
    card.querySelector('.card-tag').textContent = shot?.style && Object.keys(shot.style).length ? 'Variation' : '';
  }
  $('board').classList.toggle('has-selection', state.selection.size > 0);
  syncToolbar();
}

let drawPending = false;
function scheduleDraw() {
  scheduleSave();
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; drawAll(); });
}

function drawAll() {
  for (const f of frames.values()) {
    const shot = state.shots.find(s => s.id === f.shotId);
    if (!shot) continue;
    const mine = editing && editing.shotId === f.shotId && editing.lang === f.lang && editing.target === f.target;
    f.nodes = buildComposition(f.layer, sizeOf(f.target, shot), { ...compositionProps(shot, f.target, f.lang), hide: mine ? editing.key : null });
    placeTextHits(f);
  }
  if (editing) positionEditor();
}

function renderBoard({ fit = false } = {}) {
  for (const g of state.groups) if (!g.shots.length) g.shots.push(newShot(g));   // every group has a card to fill
  const has = true;
  $('empty').hidden = true;
  for (const id of ['board', 'dock', 'boardTools', 'zoomTools', 'scopeLabel']) $(id).hidden = !has;
  $('exportBtn').disabled = !state.shots.some(hasAnyImage);
  $('sampleBtn').hidden = state.shots.some(hasAnyImage);
  $('langLabel').textContent = state.langs.length > 1 ? `${state.langs.length} languages` : 'Translate';
  if (!has) return;
  renderSidePanel();
  const key = JSON.stringify([state.groups.map(g => [g.device, g.shots.map(s => [s.id, s.target, s.pose])]), state.langs, state.colors, state.licensed, focusedGroup()?.id, focusedLang(), focus.compare]);
  if (key !== structureKey) { buildStructure(); structureKey = key; requestAnimationFrame(schedulePixelRatio); }
  syncSelectionUI();
  drawAll();
  if (fit) requestAnimationFrame(fitBoard);
  scheduleSave();
}

function refresh(opts) { renderBoard(opts); }

// ---------- Selection and screenshot actions ----------
function selectShot(id, additive) {
  if (additive) { if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id); }
  else state.selection = new Set([id]);
  syncSelectionUI();
}
function clearSelection() {
  if (!state.selection.size) return;
  state.selection.clear();
  syncSelectionUI();
}

function duplicateShot(id) {
  const g = groupOf(id);
  const t = targetOf(g.shots.find(s => s.id === id));
  if (countOn(g, t.id) >= MAX_SHOTS) return toast(`${targetLabel(t)} has its ${MAX_SHOTS} screenshots, the App Store maximum.`);
  const i = g.shots.findIndex(s => s.id === id);
  const s = g.shots[i];
  const copy = { ...s, id: nextId++, text: structuredClone(s.text), tsrc: structuredClone(s.tsrc || {}), style: { ...(s.style || {}) } };
  g.shots.splice(i + 1, 0, copy);
  state.selection = new Set([copy.id]);
  refresh();
  toast('Duplicated. Change its layout, theme or text to make a variation.');
}
function moveShot(id, dir) {
  const g = groupOf(id);
  const i = g.shots.findIndex(s => s.id === id), j = i + dir;
  if (j < 0 || j >= g.shots.length) return;
  [g.shots[i], g.shots[j]] = [g.shots[j], g.shots[i]];
  refresh();
}
function deleteShot(id) {
  if (editing?.shotId === id) stopEditing();
  const g = groupOf(id);
  g.shots = g.shots.filter(s => s.id !== id);
  state.selection.delete(id);
  refresh();
}
/** Another frame for the same kind of device; screens, texts and orientation stay. */
async function switchModel(group, id) {
  await loadFrame(id, state.colors[id]);
  const from = targetsOfDevice(group.device), to = targetsOfDevice(id);
  for (const s of group.shots) s.target = to[from.findIndex(t => t.id === targetOf(s).id)]?.id || to[0].id;
  group.device = id;
  state.models[deviceById(id).family] = id;
  saveDevicePrefs();
  refresh();
}

/** The group's options menu: which frame, its finish, change or remove the device. */
function openGroupMenu(group, anchor) {
  const menu = $('groupMenu'), device = deviceById(group.device);
  menu.innerHTML = '';
  const card = el('div', 'card menu');
  const row = (label, onclick, cls = '') => {
    const b = el('button', `menu-row ${cls}`, label);
    b.type = 'button';
    b.onclick = () => { menu.hidePopover(); onclick(); };
    card.appendChild(b);
    return b;
  };
  const models = DEVICES.filter(d => d.family === device.family && state.available[d.id]?.length);
  if (models.length > 1) {
    card.appendChild(el('div', 'menu-label', 'Frame'));
    for (const m of models) {
      const b = row(`<span>${m.name}</span>`, () => m.id !== group.device && switchModel(group, m.id));
      if (m.id === group.device) { b.insertAdjacentHTML('beforeend', ICON.check); b.setAttribute('aria-current', 'true'); }
    }
  }
  const finishes = state.available[device.id] || [];
  if (finishes.length > 1) {
    card.appendChild(el('div', 'menu-label', 'Finish'));
    const sw = el('div', 'swatches menu-swatches');
    sw.dataset.device = device.id;
    for (const c of finishes) {
      const b = el('button');
      b.type = 'button'; b.dataset.color = c.id; b.title = c.name; b.setAttribute('aria-label', `${device.name} finish: ${c.name}`);
      b.setAttribute('aria-pressed', String(state.colors[device.id] === c.id));
      b.style.setProperty('--swatch', c.swatch);
      b.onclick = async () => {
        await loadFrame(device.id, c.id); state.colors[device.id] = c.id; saveDevicePrefs(); renderBoard();
        for (const x of sw.children) x.setAttribute('aria-pressed', String(x === b));
      };
      sw.appendChild(b);
    }
    card.appendChild(sw);
  }
  card.appendChild(el('hr', 'menu-rule'));
  row('Change device…', () => openDeviceDialog({ replace: group.id }));
  if (state.groups.length > 1) row(`Remove ${device.name}`, () => removeGroup(group.id), 'danger');
  menu.appendChild(card);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, innerWidth - 232)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.showPopover();
  anchor.classList.add('open');
  menu.addEventListener('toggle', (e) => { if (e.newState === 'closed') anchor.classList.remove('open'); }, { once: true });
}

function removeGroup(id) {
  if (state.groups.length < 2) return;
  const g = state.groups.find(x => x.id === id);
  if (editing && g.shots.some(s => s.id === editing.shotId)) stopEditing();
  for (const s of g.shots) state.selection.delete(s.id);
  state.groups = state.groups.filter(x => x.id !== id);
  saveDevicePrefs();
  refresh({ fit: true });
}

function removeLang(lang) {
  if (lang === state.baseLang) return;
  if (editing?.lang === lang) stopEditing();
  state.langs = state.langs.filter(l => l !== lang);
  for (const s of state.shots) delete s.text[lang];
  renderLangChecks();
  refresh({ fit: true });
}

// ---------- Inline text editing ----------
// Every frame has transparent hit areas over its headline and subheadline. Clicking one opens a
// textarea inside that frame, styled like the rendered text, so it zooms and pans with the board.
function placeTextHits(f) {
  const box = f.el.querySelector('.text-hits');
  box.innerHTML = '';
  f.hits = {};
  const scr = f.nodes.screen;
  if (scr?.empty) {
    const add = el('button', 'screen-add');
    add.type = 'button';
    add.setAttribute('aria-label', `Add a screenshot to ${targetLabel(targetById(f.target))}`);
    Object.assign(add.style, { left: `${scr.x * K}px`, top: `${scr.y * K}px`, width: `${scr.width * K}px`, height: `${scr.height * K}px` });
    add.onclick = (e) => { e.stopPropagation(); pickImageFor(f.shotId, targetById(f.target).display.screen); };
    box.appendChild(add);
  }
  for (const key of ['headline', 'subheadline']) {
    const node = f.nodes[key];
    const r = node.getClientRect();
    const empty = !node.text();
    const rect = { x: r.x, y: r.y, width: Math.max(r.width, empty ? node.width() * K : 0), height: Math.max(r.height, node.fontSize() * K * 1.3) };
    if (empty && key === 'subheadline') { const h = f.nodes.headline.getClientRect(); rect.y = h.y + h.height + 2; }
    f.hits[key] = rect;
    const b = el('button', 'text-hit' + (empty ? ' empty' : ''));
    b.type = 'button';
    b.dataset.key = key;
    b.setAttribute('aria-label', `Edit ${key} (${langName(f.lang)})`);
    if (empty) b.textContent = key === 'headline' ? 'Add headline' : 'Add subheadline';
    Object.assign(b.style, { left: `${rect.x - 4}px`, top: `${rect.y - 3}px`, width: `${rect.width + 8}px`, height: `${rect.height + 6}px` });
    b.onclick = (e) => { e.stopPropagation(); startEditing(f, key); };
    box.appendChild(b);
  }
}

function startEditing(f, key) {
  editing = { shotId: f.shotId, lang: f.lang, target: f.target, key };
  const shot = state.shots.find(s => s.id === f.shotId);
  if (!state.selection.has(f.shotId) || state.selection.size > 1) { state.selection = new Set([f.shotId]); syncSelectionUI(); }
  const ed = $('inlineEditor');
  f.el.appendChild(ed);
  ed.value = textFor(shot, f.lang, targetById(f.target).display.screen)[key] || '';
  ed.placeholder = key === 'headline' ? 'Your best feature' : 'One line that explains it';
  ed.hidden = false;
  drawAll();
  ed.focus();
  ed.setSelectionRange(ed.value.length, ed.value.length);
}

function editingFrame() {
  return editing && frames.get(`${editing.shotId}:${editing.lang}:${editing.target}`);
}

function positionEditor() {
  const f = editingFrame();
  const ed = $('inlineEditor');
  if (!f) return;
  if (ed.parentElement !== f.el) f.el.appendChild(ed);
  const n = f.nodes[editing.key];
  const left = n.getAbsolutePosition().x - n.offsetX() * K;
  Object.assign(ed.style, {
    left: `${left}px`, top: `${f.hits[editing.key].y}px`, width: `${n.width() * K}px`,
    font: `${n.fontStyle()} ${n.fontSize() * K}px ${n.fontFamily().includes(',') ? n.fontFamily() : `"${n.fontFamily()}"`}`,
    lineHeight: String(n.lineHeight()), letterSpacing: `${n.letterSpacing() * K}px`,
    color: n.fill(), textAlign: n.align(),
  });
  ed.style.height = 'auto';
  ed.style.height = `${ed.scrollHeight}px`;
}

function stopEditing() {
  editing = null;
  const ed = $('inlineEditor');
  ed.hidden = true;
  document.body.appendChild(ed);
  drawAll();
}

function setupInlineEditor() {
  const ed = $('inlineEditor');
  ed.oninput = () => {
    const shot = editing && state.shots.find(s => s.id === editing.shotId);
    if (!shot) return;
    const screen = targetById(editing.target).display.screen;
    shot.text[editing.lang] = { ...shot.text[editing.lang], [screen]: { ...textFor(shot, editing.lang, screen), [editing.key]: ed.value.replace(/\n/g, ' ') } };
    shot.edited = true;
    scheduleDraw();
  };
  ed.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); stopEditing(); ed.blur(); }
    if (e.key === 'Tab' && editing) {   // Tab hops between headline and subheadline
      e.preventDefault();
      startEditing(editingFrame(), editing.key === 'headline' ? 'subheadline' : 'headline');
    }
  };
  ed.onblur = () => { setTimeout(() => { if (editing && document.activeElement !== ed) stopEditing(); }); };
}

// ---------- Pan, zoom, select ----------
function setupBoard() {
  const board = $('board');
  board.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
  }, { passive: false });

  const pointers = new Map();
  let drag = null, pinch = null;
  board.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.text-hit, .screen-add, .add-screen, .add-group, .group-head, .card-pose, .row-remove, .inline-editor')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    board.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      drag = null;
    } else {
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, card: e.target.closest('.shot-card'), additive: e.shiftKey || e.metaKey };
    }
  });
  board.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      view.x += mx - pinch.mx; view.y += my - pinch.my;
      zoomAt(mx, my, d / pinch.d);
      pinch = { d, mx, my };
    } else if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; board.classList.add('panning'); }
      if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; applyView(); }
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved && e.type === 'pointerup') {
      if (drag.card) selectShot(+drag.card.dataset.id, drag.additive);
      else clearSelection();
    }
    if (!pointers.size) { drag = null; board.classList.remove('panning'); }
  };
  board.addEventListener('pointerup', end);
  board.addEventListener('pointercancel', end);

  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || $('board').hidden) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') clearSelection();
    else if ((mod && e.key === '0') || (e.shiftKey && e.key === '!')) { e.preventDefault(); fitBoard(); }
    else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.25); }
    else if (mod && e.key === '-') { e.preventDefault(); zoomBy(0.8); }
    else if (mod && e.key === 'a') { e.preventDefault(); state.selection = new Set(state.shots.map(s => s.id)); syncSelectionUI(); }
    else if (mod && e.key === 'd' && state.selection.size === 1) { e.preventDefault(); duplicateShot([...state.selection][0]); }
    else if ((e.key === 'Backspace' || e.key === 'Delete') && state.selection.size) {
      for (const id of [...state.selection]) deleteShot(id);
    }
  });
  $('zoomIn').onclick = () => zoomBy(1.25);
  $('zoomOut').onclick = () => zoomBy(0.8);
  $('zoomFit').onclick = fitBoard;
  applyView();
}

// ---------- Uploads ----------
// A capture is scaled, compressed and saved in this browser (see images.js); if saving fails it's
// still used, just not kept.
async function intakeImage(file) {
  try { return (await prepareImage(file, { save: saving })).img; }
  catch (e) {
    if (!e.storage) throw new Error(`Could not read ${file.name || 'that image'}.`);
    saveFailed(e);
    return (await prepareImage(file, { save: false })).img;
  }
}

const DEFAULT_COPY = [
  ['Your best feature, first', 'One line that says why it matters.'],
  ['Pick up where you left off', 'Your place follows you, on every device.'],
  ['Find what you love', 'Smart search that keeps up with you.'],
  ['Made to feel at home', 'Thoughtful details everywhere you look.'],
  ['Ready on day one', 'Built for the newest iPhones.'],
];

function newShot(group) {
  const [headline, subheadline] = DEFAULT_COPY[(group?.shots.length || 0) % DEFAULT_COPY.length];
  const targets = targetsOfDevice(group?.device);
  const screens = [...new Set(targets.map(t => t.display.screen))];
  // A new card starts like the one before it, on a display that still has room.
  const prev = group?.shots.at(-1);
  const room = (tid) => !group || countOn(group, tid) < MAX_SHOTS;
  const target = [prev && targetOf(prev).id, firstTarget(group?.device)?.id, ...targets.map(t => t.id)].find(tid => tid && room(tid));
  return { id: nextId++, target, pose: prev?.pose || 'portrait', images: {}, text: { [state.baseLang]: sameText(screens, { headline, subheadline }) } };
}

// The group and screen whose shape is closest to the capture's: a tall capture goes to an iPhone, a
// square-ish one to the Duo's inner display, and so on.
function bestScreen(img) {
  const a = img.width / img.height;
  let best = null, bestD = Infinity;
  for (const g of state.groups) for (const t of targetsOfDevice(g.device)) for (const pose of t.display.poses || ['portrait', 'landscape']) {
    const { width, height } = t.display.size[pose];
    const d = Math.abs(Math.log(a / (width / height)));
    if (d < bestD) { bestD = d; best = { group: g, target: t, pose }; }
  }
  return best;
}

/** Bulk add: each capture fills the first card in its group whose matching screen is empty, else a new card. */
async function addFiles(files) {
  const images = [...files].filter(f => /^image\//.test(f.type));
  if (!images.length) return toast('Please drop PNG or JPEG screenshots.');
  let full = 0;
  for (const f of images) {
    try {
      const img = await intakeImage(f);
      const { group, target, pose } = bestScreen(img);
      const screen = target.display.screen;
      // An empty card on that display, else any empty card (it switches display), else a new card.
      let shot = group.shots.find(s => targetOf(s).id === target.id && !hasAnyImage(s)) || group.shots.find(s => !hasAnyImage(s));
      if (!shot && countOn(group, target.id) >= MAX_SHOTS) { full++; continue; }
      if (!shot) { shot = newShot(group); group.shots.push(shot); }
      Object.assign(shot, { target: target.id, pose, images: { ...shot.images, [screen]: img } });   // the capture's own display and orientation
    } catch (e) { toast(e.message); }
  }
  refresh({ fit: true });
  if (full) toast(`${full} screenshot${full > 1 ? 's' : ''} left out: a device takes up to ${MAX_SHOTS}, like the App Store.`);
}

// One screen of one screenshot: from the plus on an empty screen, or a file dropped on a frame.
let pendingScreen = null;
function pickImageFor(shotId, screen) {
  pendingScreen = { shotId, screen };
  $('frameFile').click();
}
async function setScreenImage(shotId, screen, file) {
  const shot = state.shots.find(s => s.id === shotId);
  if (!shot || !file || !/^image\//.test(file.type)) return;
  try {
    shot.images = { ...shot.images, [screen]: await intakeImage(file) };
    if (shot.missing) delete shot.missing[screen];
    refresh();
  }
  catch (e) { toast(e.message); }
}

const loadUrl = (src) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

// Loads the real sample captures; returns [] if they aren't in the repo, so the generated sample is used.
// A card per capture, on the display and in the orientation it was taken in (inner cards first).
async function loadSampleShots() {
  const shots = [], seen = new Set();
  for (const s of SAMPLE_SHOTS) for (const [screen, poses] of Object.entries(s.captures)) for (const [pose, src] of Object.entries(poses)) {
    if (seen.has(src)) continue;
    seen.add(src);
    const img = await loadUrl(src);
    if (img) shots.push({ id: nextId++, target: screen, pose, images: { [screen]: img },
      text: { [state.baseLang]: sameText([screen], { headline: s.headline, subheadline: s.subheadline }) } });
  }
  return shots.sort((a, b) => (a.target === b.target ? 0 : a.target === 'duo/inner' ? -1 : 1));
}

function setupDropzone() {
  const dz = $('dropzone');
  $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('fileInput').click(); });
  const over = (on) => (e) => { e.preventDefault(); dz.classList.toggle('over', on); };
  for (const target of [dz, document.querySelector('.stage-wrap')]) {
    target.addEventListener('dragover', over(true));
    target.addEventListener('dragleave', over(false));
    target.addEventListener('drop', (e) => { over(false)(e); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  }
  // The sample captures are of HearHere on iPhone Duo, so they go into the Duo group (made if needed).
  const addSample = async () => {
    const shots = await loadSampleShots();
    if (shots.length) {
      let g = state.groups.find(x => x.device === 'duo');
      if (!g && state.groups.length && !state.licensed) { g = state.groups[0]; g.device = 'duo'; g.shots = []; }
      if (!g) { g = newGroup('duo'); g.shots = []; state.groups.push(g); }
      await loadFrame('duo', state.colors.duo);
      // The captures were taken unfolded in landscape, so show the inner display that way.
      g.shots = [...g.shots.filter(x => hasAnyImage(x) || x.edited), ...shots];   // samples replace untouched empty cards
      focus.group = g.id;
      saveDevicePrefs();
      return refresh({ fit: true });
    }
    const { width, height } = sizeOf(activeTargets()[0].id);   // match the first size, so nothing is cropped
    const blob = await makeSampleScreenshot(width, height);
    addFiles([new File([blob], 'sample-screenshot.png', { type: 'image/png' })]);
  };
  $('sampleBtn').onclick = addSample;
  $('frameFile').onchange = (e) => {
    if (pendingScreen) setScreenImage(pendingScreen.shotId, pendingScreen.screen, e.target.files[0]);
    pendingScreen = null;
    e.target.value = '';
  };
}

// ---------- Text & style inputs ----------
function setupInputs() {
  const step = (d) => applyStyle({ headlineScale: Math.round(Math.min(1.4, Math.max(0.7, (activeStyle().headlineScale || 1) + d)) * 100) / 100 });
  $('sizeDown').onclick = () => step(-0.1);
  $('sizeUp').onclick = () => step(0.1);
  for (const k of ['bg1', 'bg2', 'textColor']) $(k).oninput = (e) => applyStyle({ [k]: e.target.value });
  // Colour popovers: palettes, hex fields, and each opens right above its button.
  const shade = (hex, k) => '#' + hex.slice(1).match(/../g).map(h => Math.round(parseInt(h, 16) * k).toString(16).padStart(2, '0')).join('');
  const setBg = (c) => applyStyle({ bg1: c, bg2: shade(c, 0.96) });
  const palette = (id, colors, pick) => {
    for (const c of colors) {
      const b = el('button');
      b.type = 'button'; b.dataset.c = c; b.title = c; b.setAttribute('aria-label', c);
      b.style.background = c;
      b.onclick = () => pick(c);
      $(id).appendChild(b);
    }
  };
  palette('bgSwatches', ['#FFFFFF', '#F2EEEA', '#F6E3D8', '#FBEBC8', '#DFE5DC', '#E7EAEF', '#E9E1F2', '#FE5919', '#2F5D50', '#1B2740', '#3B1F2B', '#1A1918'], setBg);
  palette('textSwatches', ['#121212', '#6B645E', '#FFFFFF', '#FE5919', '#1B2740', '#2F5D50'], c => applyStyle({ textColor: c }));
  const hexInput = (id, apply) => {
    $(id).onchange = (e) => {
      let v = e.target.value.trim(); if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v)) apply(v.toUpperCase()); else syncStyleInputs();
    };
    $(id).onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
  };
  hexInput('bgHex', setBg);
  hexInput('textHex', c => applyStyle({ textColor: c }));
  $('bg1').oninput = (e) => setBg(e.target.value);
  for (const [pop, btn] of [['stylePop', 'customBg'], ['textPop', 'textBtn']]) {
    $(pop).addEventListener('beforetoggle', (e) => {
      $(btn).classList.toggle('open', e.newState === 'open');
      if (e.newState !== 'open') return;
      const r = $(btn).getBoundingClientRect();
      $(pop).style.left = `${Math.max(12, Math.min(innerWidth - 232, r.left + r.width / 2 - 110))}px`;
      $(pop).style.bottom = `${innerHeight - r.top + 14}px`;
    });
  }
  const fs = $('fontSelect');
  for (const [k, f] of Object.entries(FONTS)) fs.add(new Option(f.label, k));
  fs.onchange = (e) => applyStyle({ font: e.target.value });
  window.addEventListener('resize', () => renderBoard());
}

// ---------- Devices: the groups on the board ----------
// The board has a group per device. The picker (a centred dialog with a sketch per device) only
// chooses which device: for the first group, a new one, or to switch one. Finish and orientation are
// set on the board, in each group's header. Free has one group; Pro any number.
const POSE_ICON = {
  portrait: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="3" width="8" height="14" rx="2.2"/></svg>',
  landscape: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="6" width="14" height="8" rx="2.2"/></svg>',
};
// Display + orientation glyphs: the unfolded inner screen has a fold line, the cover screen a camera.
const SCREEN_ICON = {
  'inner-portrait': '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="2.5" width="13" height="15" rx="2.6"/><path d="M3.5 10h13" class="hinge"/></svg>',
  'inner-landscape': '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.6"/><path d="M10 3.5v13" class="hinge"/></svg>',
  'outer-portrait': '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 3h6a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5h-6z"/><circle cx="12.3" cy="5.7" r="0.95" class="cam"/></svg>',
  'outer-landscape': '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 13.5v-6A2.5 2.5 0 0 1 5.5 5h9A2.5 2.5 0 0 1 17 7.5v6z"/><circle cx="5.7" cy="7.7" r="0.95" class="cam"/></svg>',
};
const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.5l2.6 2.5L12 5.5"/></svg>';
const SKETCH = {
  // iPhone, drawn to the real proportions: body ≈ 0.49 : 1, corners ≈ 15% of the width,
  // a slim Dynamic Island ≈ 22% of the width, side buttons.
  iphone: `<svg viewBox="0 0 220 120" aria-hidden="true">
    <rect x="83" y="5" width="54" height="110" rx="8.5"/>
    <rect x="104" y="11.3" width="12" height="3.4" rx="1.7" class="ink"/>
    <path d="M81.6 21v5M81.6 29.5v8M81.6 40v8M138.4 32v13" class="btn"/></svg>`,
  duo: `<svg viewBox="0 0 220 120" aria-hidden="true">
    <path d="M73 8h60a14 14 0 0 1 14 14v76a14 14 0 0 1-14 14H73z"/><circle cx="134" cy="21" r="4.2" class="ink"/></svg>`,
  ipad: `<svg viewBox="0 0 220 120" aria-hidden="true">
    <rect x="46" y="14" width="128" height="92" rx="9"/><circle cx="110" cy="19" r="1.6" class="ink"/></svg>`,
  mac: `<svg viewBox="0 0 220 120" aria-hidden="true">
    <rect x="52" y="12" width="116" height="76" rx="6"/><path d="M38 96h144l-5 7H43z"/><path d="M103 12h14v3.5h-14z" class="ink"/></svg>`,
};
const PREFS_KEY = 'hhstudio.devices';
let picker = null;   // { mode: 'first' | 'new' | 'add' | 'replace', groupId?, family, model }

function newGroup(device) {
  const g = { id: nextId++, device, shots: [] };
  g.shots.push(newShot(g));
  return g;
}

/** A group for another device that mirrors `like`: as many cards, the same headlines in every language and
 *  the same per-card design. Captures stay empty, since they belong to the other device's screens. */
function groupLike(device, like) {
  if (!like?.shots.length) return newGroup(device);
  const g = { id: nextId++, device, shots: [] };
  const screens = [...new Set(targetsOfDevice(device).map(t => t.display.screen))];
  const firstOf = (byScreen) => byScreen && Object.values(byScreen)[0];
  for (const src of like.shots) {
    const shot = newShot(g);
    if (!shot.target) break;   // every screen has its 10
    for (const [lang, byScreen] of Object.entries(src.text || {})) if (firstOf(byScreen)) shot.text[lang] = sameText(screens, firstOf(byScreen));
    for (const [lang, byScreen] of Object.entries(src.tsrc || {})) if (firstOf(byScreen)) (shot.tsrc ||= {})[lang] = sameText(screens, firstOf(byScreen));
    if (src.style && Object.keys(src.style).length) shot.style = { ...src.style };
    if (src.edited) shot.edited = true;
    g.shots.push(shot);
  }
  return g;
}

// One group per kind of device: every iPhone frame exports the same 6.9″ size, so there's one iPhone set.
const usedElsewhere = (id) => picker?.mode !== 'first' && picker?.mode !== 'new' && state.groups.some(g => deviceById(g.device).family === deviceById(id).family && g.id !== picker?.groupId);

function renderDeviceList() {
  const list = $('deviceList');
  list.innerHTML = '';
  for (const fam of FAMILIES) {
    const models = DEVICES.filter(d => d.family === fam.id && state.available[d.id]?.length);
    const free = models.filter(m => !usedElsewhere(m.id));
    if (!models.length && !fam.soon) continue;
    const on = picker.family === fam.id;
    const tile = el('section', 'tile' + (on ? ' on' : '') + (free.length ? '' : ' taken'));
    tile.dataset.family = fam.id;
    const pick = el('button', 'tile-select', `<span class="tile-sketch">${SKETCH[fam.id] || ''}</span>
      <span class="tile-text"><span class="tile-name"></span><span class="tile-note"></span></span><span class="tile-check">${CHECK}</span>`);
    pick.type = 'button';
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-checked', String(on));
    pick.disabled = !free.length;
    if (fam.soon) tile.classList.add('soon');
    pick.querySelector('.tile-name').textContent = fam.name;
    pick.querySelector('.tile-note').textContent = fam.soon ? fam.note : !free.length ? 'Already on the board' : fam.note;
    pick.onclick = () => { picker.family = fam.id; picker.model = (free.find(m => m.id === state.models[fam.id]) || free[0]).id; renderDeviceList(); };
    tile.appendChild(pick);
    list.appendChild(tile);
  }
  const d = deviceById(picker.model);
  $('deviceSummary').textContent = '';
  $('deviceDone').disabled = !d;
}

/** mode: 'first' (first visit, can't be closed), 'new' (a new board), 'add', or { replace: groupId }. */
function openDeviceDialog(mode = 'add') {
  const replace = typeof mode === 'object' ? mode.replace : null;
  const kind = replace ? 'replace' : mode;
  const current = replace && state.groups.find(g => g.id === replace).device;
  picker = { mode: kind, groupId: replace };
  // The first device on offer, in the order the picker shows them (iPhone first).
  const firstFree = FAMILIES.flatMap(f => DEVICES.filter(d => d.family === f.id)).find(d => state.available[d.id]?.length && !usedElsewhere(d.id));
  const start = current ? deviceById(current) : firstFree;
  picker.family = start?.family; picker.model = start?.id;
  const dlg = $('deviceDialog');
  dlg.classList.toggle('first', kind === 'first');
  $('deviceTitle').innerHTML = kind === 'first' ? 'What are your screenshots for?'
    : kind === 'new' ? 'New board<span class="dot">.</span>'
    : kind === 'replace' ? 'Change device<span class="dot">.</span>' : 'Add a device<span class="dot">.</span>';
  $('deviceLead').textContent = kind === 'first' || kind === 'new'
    ? 'Pick a device to start. You can add more later, each in its own group.'
    : kind === 'replace' ? 'Your headlines stay; the screens empty for the new device.'
    : 'It gets its own group of screenshots on the board.';
  $('deviceDone').textContent = kind === 'first' ? 'Continue' : kind === 'new' ? 'Create board' : kind === 'replace' ? 'Change' : 'Add device';
  renderDeviceList();
  if (!dlg.open) { dlg.showModal(); dlg.focus(); }   // focus the dialog, not a tile, so no ring shows until keyboard use
}

async function confirmDevice() {
  const id = picker?.model;
  if (!id) return;
  await loadFrame(id, state.colors[id]);
  state.models[deviceById(id).family] = id;
  if (picker.mode === 'new') {   // a new board: only made now that a device is picked
    $('deviceDialog').close();
    saveDevicePrefs();
    await newBoard({ device: id });
    return;
  }
  if (picker.mode === 'replace') {
    const g = state.groups.find(x => x.id === picker.groupId);
    if (g.device !== id) {
      g.device = id;
      for (const s of g.shots) { s.images = {}; delete s.target; s.pose = 'portrait'; }   // captures belong to the old device's screens
    }
    focus.group = g.id;
  } else if (picker.mode === 'first') {
    state.groups = [newGroup(id)];
    focus.group = state.groups[0].id;
  } else {
    state.groups.push(groupLike(id, state.groups[0]));
    focus.group = state.groups.at(-1).id;
  }
  $('deviceDialog').close();
  saveDevicePrefs();
  syncToolbar();
  refresh({ fit: true });
}

function saveDevicePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ groups: state.devices, models: state.models, colors: state.colors })); } catch {}
}

function loadDevicePrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { return null; }
}

/** Sets up the device groups from last time (or a Duo group). Returns true on a first visit. */
function setupDevice(available) {
  state.available = available;
  for (const [id, colors] of Object.entries(available)) state.colors[id] = colors[0].id;
  for (const fam of FAMILIES) state.models[fam.id] = DEVICES.find(d => d.family === fam.id && available[d.id])?.id;
  const prefs = loadDevicePrefs();
  if (prefs) {   // only keep what still exists
    for (const [fam, id] of Object.entries(prefs.models || {})) if (available[id]) state.models[fam] = id;
    for (const [id, c] of Object.entries(prefs.colors || {})) if (available[id]?.some(x => x.id === c)) state.colors[id] = c;
  }
  let devices = [...new Set((prefs?.groups || prefs?.devices || []).filter(id => available[id]))];
  if (!devices.length) devices = [Object.keys(available)[0] || 'duo'];
  if (!storedLicenseKey()) devices = devices.slice(0, 1);
  state.groups = devices.map(newGroup);
  $('deviceDone').onclick = confirmDevice;
  $('deviceClose').onclick = () => $('deviceDialog').close();
  $('deviceDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget && picker?.mode !== 'first') e.currentTarget.close(); });   // backdrop
  $('deviceDialog').addEventListener('cancel', (e) => { if (picker?.mode === 'first') e.preventDefault(); });
  return !prefs;
}

// ---------- Translate (Pro) ----------
const langName = (code) => LANGUAGES.find(l => l[0] === code)?.[1] || code;

// The picker opens out of whatever opened it: beside the side panel's "Add languages" row on desktop,
// under the panel strip on phones, under the top bar's button otherwise.
let langAnchor = null, langClosedAt = 0;
function openLangPicker(anchor) {
  const pop = $('langPop');
  // A second click on the same opener closes it (light dismiss may already have, on pointerdown).
  if (pop.matches(':popover-open')) return pop.hidePopover();
  if (langAnchor && (langAnchor.id || langAnchor.className) === (anchor.id || anchor.className) && performance.now() - langClosedAt < 250) return;   // the panel re-renders its rows, so compare by kind
  langAnchor = anchor;
  $('langSearch').value = '';
  $('translateStatus').textContent = '';
  renderLangChecks();
  pop.showPopover();
  placeLangPicker();
  if (matchMedia('(pointer: fine)').matches) $('langSearch').focus({ preventScroll: true });
}

function placeLangPicker() {
  const pop = $('langPop');
  if (!pop.matches(':popover-open') || !langAnchor) return;
  const r = langAnchor.getBoundingClientRect(), panel = $('sidePanel').getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight, m = 12;
  let left, top, from;
  if (langAnchor.closest('#sidePanel') && !narrowMq.matches) {   // beside the panel, level with the row
    left = panel.right + 10; top = r.top - 14; from = 'side';
  } else if (langAnchor.closest('#sidePanel')) {   // phones: below the strip of chips
    left = (innerWidth - w) / 2; top = panel.bottom + 8; from = 'top';
  } else {
    left = r.right - w; top = r.bottom + 8; from = 'top';
  }
  left = Math.max(m, Math.min(left, innerWidth - w - m));
  top = Math.max(m, Math.min(top, innerHeight - h - m));
  Object.assign(pop.style, { left: `${left}px`, top: `${top}px` });
  pop.dataset.from = from;
  // The arrow points at the row it came from, while it's in reach.
  pop.style.setProperty('--arrow-y', `${Math.max(18, Math.min(h - 18, r.top + r.height / 2 - top))}px`);
}

function renderLangChecks() {
  const box = $('langChecks');
  const q = $('langSearch').value.trim().toLowerCase();
  const picked = new Set(selectedTargets());
  box.innerHTML = '';
  const base = langName(state.baseLang);
  $('langSub').textContent = `Headlines are translated from ${base}. You can edit every line after.`;
  $('langPro').hidden = state.licensed;
  const match = ([code, name]) => code !== state.baseLang && (!q || name.toLowerCase().includes(q) || code.toLowerCase().startsWith(q));
  const onBoard = LANGUAGES.filter(l => match(l) && state.langs.includes(l[0]));
  const rest = LANGUAGES.filter(l => match(l) && !state.langs.includes(l[0]));
  const section = (title, list, done) => {
    if (!list.length) return;
    box.appendChild(el('div', 'lang-section', title));
    for (const [code, name] of list) {
      const l = el('label', 'lang-check' + (done ? ' done' : ''));
      l.innerHTML = '<input type="checkbox"><span class="lang-box" aria-hidden="true"></span><span class="lang-name"></span><span class="lang-code"></span>';
      const input = l.querySelector('input');
      input.value = code;
      input.checked = picked.has(code);
      l.querySelector('.lang-name').textContent = name;
      l.querySelector('.lang-code').textContent = done ? 'Update' : code;
      if (done) l.title = 'Translates only the lines that changed since';
      box.appendChild(l);
    }
  };
  section('On this board', onBoard, true);
  section(onBoard.length ? 'Add' : 'Languages', rest, false);
  if (!onBoard.length && !rest.length) box.appendChild(el('p', 'lang-empty', `No language matches “${$('langSearch').value.trim()}”.`));
  syncTranslateButton();
}

function selectedTargets() {
  return [...$('langChecks').querySelectorAll('input:checked')].map(i => i.value);
}

function syncTranslateButton() {
  const boxes = [...$('langChecks').querySelectorAll('input')];
  const n = boxes.filter(i => i.checked).length;
  const all = $('langAll');
  all.checked = boxes.length > 0 && n === boxes.length;
  all.indeterminate = n > 0 && n < boxes.length;
  all.disabled = !boxes.length;
  $('langAllCount').textContent = String(boxes.length);
  $('translateCount').textContent = n ? `${n} selected` : 'Pick languages';
  $('translateBtn').disabled = !n;
  $('translateBtn').textContent = !state.licensed ? 'Get Pro to translate' : n ? `Translate ${n}` : 'Translate';
}

function setupTranslate() {
  renderLangChecks();
  $('langChecks').onchange = syncTranslateButton;
  $('langAll').onchange = (e) => { for (const i of $('langChecks').querySelectorAll('input')) i.checked = e.target.checked; syncTranslateButton(); };
  $('langSearch').oninput = () => renderLangChecks();
  $('langSearch').onkeydown = (e) => { if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; renderLangChecks(); } };
  $('langClose').onclick = () => $('langPop').hidePopover();
  $('langBtn').onclick = () => openLangPicker($('langBtn'));
  addEventListener('resize', placeLangPicker);
  $('langPop').addEventListener('beforetoggle', (e) => { if (e.newState === 'closed') langClosedAt = performance.now(); });   // sync, unlike toggle
  $('translateBtn').onclick = async () => {
    if (!state.licensed) { $('langPop').hidePopover(); $('licensePop').showPopover(); return; }
    if (!state.shots.length) return toast('Add screenshots first.');
    const targets = selectedTargets();
    // Every screen's words in the base language. Each translation remembers the words it was made
    // from (shot.tsrc), so translating again only sends lines that changed since, and a language that's
    // already up to date costs nothing. Hand edits to lines that didn't change are kept.
    const slots = state.shots.flatMap(s => screensOf(s).map(screen => ({ s, screen, base: textFor(s, state.baseLang, screen) })));
    const FIELDS = ['headline', 'subheadline'];
    const changed = (lang) => slots.flatMap(({ s, screen, base }, i) => FIELDS
      .filter(f => base[f] && (s.text[lang]?.[screen]?.[f] == null || s.tsrc?.[lang]?.[screen]?.[f] !== base[f]))
      .map(f => [i, f]));
    const put = (lang, i, f, value) => {
      const { s, screen, base } = slots[i];
      s.text[lang] = { ...s.text[lang], [screen]: { headline: '', subheadline: '', ...s.text[lang]?.[screen], [f]: value } };
      s.tsrc = { ...s.tsrc, [lang]: { ...s.tsrc?.[lang], [screen]: { ...s.tsrc?.[lang]?.[screen], [f]: base[f] } } };
    };
    // Languages that need the same lines go together, up to 12 per request.
    const batches = new Map();
    const upToDate = [];
    for (const lang of targets) {
      const need = changed(lang);
      // Empty lines need no translating: mirror them so the language is complete.
      slots.forEach(({ base }, i) => FIELDS.forEach(f => { if (!base[f]) put(lang, i, f, ''); }));
      if (!need.length) { upToDate.push(lang); continue; }
      const k = JSON.stringify(need);
      if (!batches.has(k)) batches.set(k, { need, langs: [] });
      batches.get(k).langs.push(lang);
    }
    const requests = [...batches.values()].flatMap(({ need, langs }) => {
      const out = [];
      for (let i = 0; i < langs.length; i += 12) out.push({ need, langs: langs.slice(i, i + 12) });
      return out;
    });
    $('translateBtn').disabled = true;
    for (const { langs } of requests) for (const lang of langs) translating.add(lang);
    renderSidePanel();
    const done = [], failed = [];
    let usage, lines = 0, error = '';
    try {
      for (const [n, { need, langs }] of requests.entries()) {
        $('translateStatus').textContent = `Translating${requests.length > 1 ? ` (${n + 1} of ${requests.length})` : ''}…`;
        const res = await translateTexts(need.map(([i, f]) => slots[i].base[f]), langs, state.baseLang, storedLicenseKey());
        for (const [lang, out] of Object.entries(res.translations)) {
          need.forEach(([i, f], j) => put(lang, i, f, out[j]));
          done.push(lang);
        }
        failed.push(...res.failed);
        for (const lang of langs) translating.delete(lang);   // this batch has landed: its rows stop shimmering
        for (const lang of Object.keys(res.translations)) if (!state.langs.includes(lang)) state.langs.push(lang);
        renderSidePanel();
        lines = Math.max(lines, need.length);
        usage = res.usage;
      }
    } catch (e) {
      error = e.message;
    } finally {
      translating.clear();
    }
    for (const lang of [...done, ...upToDate]) if (!state.langs.includes(lang)) state.langs.push(lang);
    for (const i of $('langChecks').querySelectorAll('input')) if (done.includes(i.value) || upToDate.includes(i.value)) i.checked = false;
    renderLangChecks();
    placeLangPicker();
    refresh({ fit: true });
    const left = usage ? ` ${usage.limit - usage.runs} of ${usage.limit} left this month.` : '';
    $('translateStatus').textContent = [
      done.length && `Translated ${lines} line${lines > 1 ? 's' : ''} into ${done.map(langName).join(', ')}. Review the text: exports include every language.`,
      upToDate.length && `${upToDate.map(langName).join(', ')} already up to date (not counted).`,
      failed.length && `Couldn't translate ${failed.map(langName).join(', ')}; try again.`,
      error,
    ].filter(Boolean).join(' ') + left;
    syncTranslateButton();
  };
}

// ---------- License (Pro) ----------
const maskKey = (k) => (k.length > 14 ? `${k.slice(0, 8)}…${k.slice(-4)}` : k);

async function copyKey(btn, key) {
  try { await navigator.clipboard.writeText(key); }
  catch {   // older browsers or no permission: select it so ⌘C works
    const field = btn.previousElementSibling;
    if (field?.select) field.select();
    return toast('Press ⌘C or Ctrl+C to copy the key.');
  }
  const label = btn.lastChild;
  btn.classList.add('copied'); label.textContent = 'Copied';
  setTimeout(() => { btn.classList.remove('copied'); label.textContent = 'Copy'; }, 1800);
}

function showWelcome(key) {
  $('welcomeKey').value = key;
  $('licensePop').hidePopover?.();
  $('proWelcome').showModal();
  $('welcomeCopy').focus();
}

function applyLicense(valid, message) {
  state.licensed = valid;
  const key = storedLicenseKey();
  $('licenseForm').hidden = valid;
  $('licenseActive').hidden = !valid;
  $('activeKey').textContent = valid ? maskKey(key) : '';
  $('licenseBadge').textContent = valid ? 'Pro' : 'Free · watermark';
  $('licenseBadge').classList.toggle('pro', valid);
  if (message) $('licenseStatus').textContent = message;
  syncTranslateButton();
  if ($('deviceDialog').open) renderDeviceList();
  if (valid) sync?.schedule(200);
  renderSyncControls();
  structureKey = '';   // the "Add device" button shows or drops its Pro tag
  renderBoard();
}

function setupLicense() {
  $('proPrice').textContent = PRO.price;
  const buy = $('buyBtn');
  if (PRO.checkoutUrl) buy.href = PRO.checkoutUrl;
  else { buy.removeAttribute('href'); buy.classList.add('disabled'); buy.title = 'Checkout is not set up yet'; }
  const saved = storedLicenseKey();
  if (saved) { $('licenseKey').value = saved; checkLicense(saved).then(r => applyLicense(r.valid, r.message)); }
  $('licenseBtn').onclick = async () => {
    $('licenseBtn').disabled = true;
    $('licenseStatus').textContent = 'Checking…';
    const r = await checkLicense($('licenseKey').value);
    $('licenseBtn').disabled = false;
    applyLicense(r.valid, r.message);
  };
  $('licenseKey').onkeydown = (e) => { if (e.key === 'Enter') $('licenseBtn').click(); };
  $('activeCopy').onclick = () => copyKey($('activeCopy'), storedLicenseKey());
  $('welcomeCopy').onclick = () => copyKey($('welcomeCopy'), $('welcomeKey').value);
  $('welcomeDone').onclick = () => $('proWelcome').close();
  $('forgetBtn').onclick = () => {
    forgetLicense();
    $('licenseKey').value = '';
    applyLicense(false, 'Removed from this browser. Paste your key to unlock again.');
  };
  // Back from Polar checkout: open the license popover ready for the key.
  const params = new URLSearchParams(location.search);
  if (params.get('checkout') === 'success') {
    const checkoutId = params.get('checkout_id');
    history.replaceState(null, '', location.pathname);
    if (!checkoutId) {
      requestAnimationFrame(() => $('licensePop').showPopover());
      $('licenseStatus').textContent = 'Thanks for buying Pro! Paste the license key from your receipt email.';
      return;
    }
    requestAnimationFrame(() => $('licensePop').showPopover());
    $('licenseStatus').textContent = 'Thanks for buying Pro! Unlocking…';
    $('licenseBtn').disabled = true;
    claimCheckout(checkoutId).then(r => {
      $('licenseBtn').disabled = false;
      if (r.valid) {
        $('licenseKey').value = r.key;
        applyLicense(true, 'Pro unlocked. Thank you!');
        showWelcome(r.key);
      } else {
        $('licenseStatus').textContent = r.message;
        $('licenseKey').focus();
      }
    });
  }
}

// ---------- Export ----------
// "iPhone-Duo-inner", "iPhone-Air": one folder per App Store display size; App Store Connect takes
// portrait and landscape screenshots in the same slot.
const folderName = (t) => (t.device.family === 'iphone' ? 'iPhone-6.9in' : `${t.device.name.replace(/\s+/g, '-')}${t.display.label ? '-' + t.display.id : ''}`);

async function renderToPng(shot, tid, lang) {
  const size = sizeOf(tid, shot);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;';
  document.body.appendChild(host);
  const stage = new Konva.Stage({ container: host, width: size.width, height: size.height });
  const layer = new Konva.Layer({ listening: false });
  stage.add(layer);
  try {
    buildComposition(layer, size, compositionProps(shot, tid, lang));
    const canvas = stage.toCanvas({ pixelRatio: 1 });
    if (canvas.width !== size.width || canvas.height !== size.height) throw new Error(`Rendered ${canvas.width}×${canvas.height}, expected ${size.width}×${size.height}`);
    return await canvasToRgbPng(canvas);
  } finally {
    stage.destroy();
    host.remove();
  }
}

async function exportZip() {
  const btn = $('exportBtn');
  btn.disabled = true;
  const zip = new JSZip();
  const jobs = [];
  const targets = activeTargets();
  let skipped = 0;
  const count = {};   // numbered per folder, so skipped empty frames leave no gaps
  for (const lang of state.langs) state.shots.forEach(s => targetsOf(s).forEach(t => {
    if (imageFor(s, t.display.screen)) jobs.push({ lang, s, i: (count[lang + t.id] = (count[lang + t.id] || 0) + 1) - 1, t });
    else if (lang === state.baseLang) skipped++;
  }));
  if (!jobs.length) { btn.disabled = false; return toast('Add a screenshot to a frame first.'); }
  showProgress(0, jobs.length);
  try {
    let done = 0;
    for (const { lang, s, i, t } of jobs) {
      const blob = await renderToPng(s, t.id, lang);
      const folder = state.langs.length > 1 ? `${lang}/` : '';
      zip.file(`${folder}${folderName(t)}/${String(i + 1).padStart(2, '0')}.png`, blob);
      showProgress(++done, jobs.length);
      await new Promise(r => setTimeout(r)); // keep UI responsive
    }
    zip.file('README.txt', `App Store screenshots — made with HearHere Studio\n\n` +
      targets.map(t => `${targetLabel(t)}: ${folderName(t)} (${t.display.size.portrait.width} × ${t.display.size.portrait.height}${t.display.poses ? '' : ' or landscape'})`).join('\n') +
      `\n\nUpload each folder to the matching device size in App Store Connect (1–10 per size).\nPNG, RGB, no alpha channel.\n`);
    const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = 'app-store-screenshots.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    toast(`Exported ${jobs.length} screenshots${state.licensed ? '' : ' (with watermark — unlock to remove)'}.`
      + (skipped ? ` Skipped ${skipped} empty frame${skipped > 1 ? 's' : ''}.` : ''));
    window.__lastExport = { count: jobs.length, bytes: out.size };
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + e.message);
  } finally {
    btn.disabled = !state.shots.some(hasAnyImage);
  }
}

// ---------- Toast / progress ----------
let toastTimer;
function toast(msg, sticky = false) {
  const t = $('toast');
  t.hidden = false; t.textContent = msg;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => (t.hidden = true), 4000);
}
function showProgress(done, total) {
  const t = $('toast');
  t.hidden = false;
  t.innerHTML = `Rendering ${done}/${total} screenshots…<div class="progress"><i style="width:${(done / total) * 100}%"></i></div>`;
  clearTimeout(toastTimer);
}

// ---------- Boards: saving in this browser, and sync for Pro ----------
// A board is everything on the canvas. It's saved in IndexedDB (store.js) shortly after every
// change, as a document that names its captures by hash; the captures are stored once each.
const FORMAT = 1;
const TAB = crypto.randomUUID();
let saving = false;            // IndexedDB works here
let currentBoard = null;       // { id, name, createdAt }
let lastSavedJson = '';
let saveTimer = null, saveChain = Promise.resolve(), hydrating = false, lastEditAt = 0;
let unknownGroups = [];        // groups for devices this version doesn't know: kept as they were
let sync = null;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('hhstudio') : null;

const styleOut = (st) => st && Object.fromEntries(Object.entries(st).map(([k, v]) => [k, k === 'template' ? v?.id : v]));
const styleIn = (st) => st && Object.fromEntries(Object.entries(st).map(([k, v]) => [k, k === 'template' ? (templateById(v) || templateById('paper')) : v]));
const defaultStyle = () => ({ ...themePatch(templateById('paper')), layout: 'top', headlineScale: 1 });

async function serializeBoard() {
  const groups = [];
  for (const g of state.groups) {
    const shots = [];
    for (const s of g.shots) {
      const images = { ...(s.missing || {}) };   // captures still on their way from sync keep their place
      for (const [screen, img] of Object.entries(s.images || {})) {
        if (!img) continue;
        let h = hashOf(img);
        if (!h) {   // e.g. the sample captures: compress and keep them like any other
          try { const p = await prepareImage(img, { save: saving }); h = p.hash; if (s.images[screen] === img) s.images[screen] = p.img; }
          catch (e) { if (e.storage) saveFailed(e); continue; }
        }
        images[screen] = h;
      }
      shots.push({ id: s.id, target: s.target, pose: s.pose, edited: !!s.edited, style: styleOut(s.style) || null, text: s.text || {}, tsrc: s.tsrc || {}, images });
    }
    groups.push({ id: g.id, device: g.device, shots });
  }
  return { format: FORMAT, baseLang: state.baseLang, langs: [...state.langs], style: styleOut(state.style), colors: { ...state.colors }, models: { ...state.models }, groups: [...groups, ...unknownGroups] };
}

/** Puts a saved document on the canvas. */
async function hydrateBoard(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('This board is empty or damaged.');
  if (doc.format > FORMAT) throw new Error('This board was saved by a newer version of HearHere Studio. Reload the page to open it.');
  hydrating = true;
  try {
    if (editing) stopEditing();
    for (const [id, c] of Object.entries(doc.colors || {})) if (state.available[id]?.some(x => x.id === c)) state.colors[id] = c;
    for (const [fam, id] of Object.entries(doc.models || {})) if (state.available[id]) state.models[fam] = id;
    const groups = [];
    unknownGroups = [];
    let maxId = 0;
    for (const g of doc.groups || []) {
      const known = deviceById(g.device);
      const device = state.available[g.device] ? g.device : DEVICES.find(d => known && d.family === known.family && state.available[d.id])?.id;
      if (!device) { unknownGroups.push(g); continue; }
      const shots = [];
      for (const s of g.shots || []) {
        const images = {}, missing = {};
        for (const [screen, h] of Object.entries(s.images || {})) {
          const img = await imageFromHash(h);
          if (img) images[screen] = img; else missing[screen] = h;
        }
        const t = targetById(s.target);
        shots.push({
          id: s.id, target: t && t.device.id === device ? s.target : firstTarget(device)?.id, pose: s.pose || 'portrait',
          edited: !!s.edited, ...(s.style ? { style: styleIn(s.style) } : {}), text: s.text || {}, tsrc: s.tsrc || {}, images,
          ...(Object.keys(missing).length ? { missing } : {}),
        });
        maxId = Math.max(maxId, s.id || 0);
      }
      maxId = Math.max(maxId, g.id || 0);
      groups.push({ id: g.id, device, shots });
    }
    await Promise.all([...new Set(groups.map(g => g.device))].map(id => loadFrame(id, state.colors[id])));
    nextId = Math.max(nextId, maxId + 1);
    state.groups = groups.length ? groups : [newGroup(state.models[FAMILIES[0].id] || Object.keys(state.available)[0])];
    state.baseLang = doc.baseLang || 'en';
    state.langs = [...new Set([state.baseLang, ...(doc.langs || [])])].filter(l => LANGUAGES.some(x => x[0] === l));
    state.style = { ...defaultStyle(), ...(styleIn(doc.style) || {}) };
    state.selection.clear();
    Object.assign(focus, { group: null, lang: null, compare: false });
    structureKey = '';
    renderLangChecks();
    syncToolbar();
    refresh({ fit: true });
    lastSavedJson = JSON.stringify(await serializeBoard());
  } finally {
    hydrating = false;
  }
}

function scheduleSave() {
  if (!saving || !currentBoard || hydrating) return;
  lastEditAt = Date.now();
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

/** Saves the current board now (if it changed). Saves run one after another. */
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!saving || !currentBoard) return Promise.resolve();
  const board = currentBoard;
  saveChain = saveChain.then(async () => {
    const doc = await serializeBoard();
    const json = JSON.stringify(doc);
    if (json === lastSavedJson && !board.renamed) { setSaveStatus('saved'); return; }
    const now = Date.now();
    await boardStore.update(board.id, (cur) => ({
      remoteVersion: 0, createdAt: board.createdAt || now, ...(cur || {}),
      id: board.id, name: board.name, doc, updatedAt: now, dirty: true, deleted: false,
      pristine: (cur ? cur.pristine !== false : true) && isPristine(doc, board.name),
    }));
    if (currentBoard === board) lastSavedJson = json;
    board.renamed = false;
    channel?.postMessage({ type: 'saved', id: board.id, tab: TAB });
    setSaveStatus('saved');
    sync?.schedule();
  }).catch(saveFailed);
  return saveChain;
}

/** A starter board nobody has touched: no captures, no edited words, no translations, default name. */
function isPristine(doc, name) {
  return name === 'Untitled board' && doc.langs.length <= 1
    && doc.groups.every(g => g.shots.every(s => !s.edited && !Object.keys(s.images || {}).length));
}

let saveWarned = false;
function saveFailed(e) {
  console.error('save', e);
  setSaveStatus('error', e?.storage ? e.message : 'Couldn’t save in this browser. Export a backup to keep your work.');
  if (!saveWarned) { saveWarned = true; toast(e?.storage ? e.message : 'Couldn’t save this board in the browser. Use Export backup to keep your work.', true); }
}

let saveState = 'saved', saveError = '';
function setSaveStatus(s, msg = '') {
  saveState = s; saveError = msg;
  renderStatusLine();
}

function relTime(t) {
  const d = Math.round((Date.now() - t) / 60000);
  return d < 1 ? 'just now' : d < 60 ? `${d} min ago` : new Date(t).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
}

function renderStatusLine() {
  const el = $('saveStatus');
  if (!el) return;
  const st = sync?.status || { state: 'off' };
  let text, cls = '';
  if (!saving) { text = 'Not saved in this window'; cls = 'warn'; }
  else if (saveState === 'error') { text = saveError || 'Couldn’t save'; cls = 'warn'; }
  else if (saveState === 'saving') text = 'Saving…';
  else if (st.state === 'syncing') text = 'Saved · syncing…';
  else if (st.state === 'synced') text = `Saved · synced ${relTime(st.at)}`;
  else if (st.state === 'offline') { text = 'Saved · offline, will sync'; }
  else if (st.state === 'error') { text = `Saved · ${st.message}`; cls = 'warn'; }
  else text = 'Saved in this browser';
  el.textContent = text;
  el.className = `save-status ${cls}`;
  el.title = text;
  renderSyncControls();
}

const boardName = (rec) => rec?.name?.trim() || 'Untitled board';

async function listBoards() {
  if (!saving) return currentBoard ? [{ ...currentBoard, updatedAt: Date.now() }] : [];
  return (await boardStore.all()).filter(b => !b.deleted && b.doc).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Opens a saved board (saving the current one first) and shows the editor. */
async function openBoard(id) {
  await saveNow();
  const rec = await boardStore.get(id);
  if (!rec || rec.deleted || !rec.doc) return toast('That board isn’t available any more.');
  try {
    await hydrateBoard(rec.doc);
  } catch (e) { toast(e.message); return; }
  currentBoard = { id: rec.id, name: boardName(rec), createdAt: rec.createdAt };
  showHome(false);
  renderBoardChrome();
  await metaStore.set('current', rec.id).catch(() => {});
}

/** The device a board gets when one is needed without asking: the last one picked. */
const defaultDevice = () => state.models[FAMILIES[0].id] || Object.keys(state.available)[0];

/**
 * A new board: from a saved document (backup), or empty for a device. Without either, the device
 * picker opens first; the board is only made once a device is picked, so closing it changes nothing.
 */
async function newBoard({ doc = null, name = 'Untitled board', device = null } = {}) {
  if (!doc && !device) { openDeviceDialog('new'); return; }
  await saveNow();
  const id = crypto.randomUUID(), now = Date.now();
  currentBoard = { id, name, createdAt: now };
  if (doc) await hydrateBoard(doc);
  else {
    await hydrateBoard({ format: FORMAT, baseLang: 'en', langs: ['en'], style: styleOut(defaultStyle()), colors: state.colors, models: state.models, groups: [] });
    state.groups = [newGroup(device)];
    focus.group = state.groups[0].id;
    structureKey = '';
    refresh({ fit: true });
  }
  lastSavedJson = '';
  if (saving) await saveNow();
  await metaStore.set('current', id).catch(() => {});
  showHome(false);
  renderBoardChrome();
}

/** The saved record of a board, with the open one saved first so it's current. */
async function boardRecord(id) {
  if (id === currentBoard?.id) await saveNow();
  return boardStore.get(id);
}

async function renameBoardById(id, name) {
  name = name.trim().slice(0, 80) || 'Untitled board';
  if (id === currentBoard?.id) {
    currentBoard.name = name;
    currentBoard.renamed = true;
    await saveNow();
  } else {
    await boardStore.update(id, (cur) => cur && { ...cur, name, updatedAt: Date.now(), dirty: true, pristine: false });
    sync?.schedule();
  }
  renderBoardChrome();
  if (homeShown()) renderHome();
}

async function duplicateBoardById(id) {
  const rec = await boardRecord(id);
  if (!rec?.doc) return;
  const now = Date.now();
  await boardStore.put({ id: crypto.randomUUID(), name: `${boardName(rec)} copy`, doc: rec.doc, createdAt: now, updatedAt: now, remoteVersion: 0, dirty: true, deleted: false, pristine: false });
  sync?.schedule();
  if (homeShown()) renderHome();
  toast(`Duplicated “${boardName(rec)}”.`);
}

async function deleteBoardById(id) {
  const rec = await boardRecord(id);
  if (!rec) return;
  if (!confirm(`Delete “${boardName(rec)}”? This can’t be undone${sync?.enabled ? ', and it’s removed from your other browsers too' : ''}.`)) return;
  if (id === currentBoard?.id) {
    clearTimeout(saveTimer); saveTimer = null;
    await saveChain;
    currentBoard = null;   // the canvas shows nothing saved until another board is opened
  }
  if (rec.remoteVersion) await boardStore.put({ ...rec, doc: null, deleted: true, dirty: true, updatedAt: Date.now() });
  else await boardStore.delete(id);
  cleanupImages().catch(() => {});
  sync?.schedule(300);
  if (homeShown()) renderHome();
  toast('Board deleted.');
}

// ---------- Backup files ----------
// A .hhstudio file is a ZIP: board.json (the document) and images/<hash> (the captures as stored).
async function exportBackupById(id) {
  const rec = await boardRecord(id);
  if (!rec?.doc) return;
  const zip = new JSZip();
  zip.file('board.json', JSON.stringify({ app: 'HearHere Studio', format: FORMAT, name: boardName(rec), doc: rec.doc }, null, 1));
  let missing = 0;
  for (const h of imageHashesOf(rec.doc)) {
    const blob = await blobForHash(h);
    if (blob) zip.file(`images/${h}`, blob); else missing++;
  }
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(out);
  a.download = `${boardName(rec).replace(/[^\w\- ]+/g, '').trim() || 'board'}.hhstudio`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  toast(missing ? `Backup saved, but ${missing} capture${missing > 1 ? 's' : ''} weren’t in this browser yet.` : 'Backup saved.');
}

async function importBackup(file) {
  try {
    const zip = await JSZip.loadAsync(file);
    const meta = JSON.parse(await zip.file('board.json')?.async('string') || 'null');
    if (!meta?.doc || meta.app !== 'HearHere Studio') throw new Error('That isn’t a HearHere Studio backup.');
    for (const h of imageHashesOf(meta.doc)) {
      const f = zip.file(`images/${h}`);
      if (!f || !/^[0-9a-f]{64}$/.test(h)) continue;
      const bytes = await f.async('uint8array');
      const type = bytes[8] === 0x57 ? 'image/webp' : bytes[0] === 0xff ? 'image/jpeg' : 'image/png';
      const blob = new Blob([bytes], { type });
      if (saving) await storeVerified(h, blob);
    }
    await newBoard({ doc: meta.doc, name: meta.name || 'Imported board' });
    toast(`Opened “${currentBoard.name}”.`);
  } catch (e) {
    console.error(e);
    toast(e.message?.includes('HearHere') || e.message?.includes('newer') ? e.message : 'Couldn’t open that backup file.');
  }
}

// ---------- Boards page ----------
// All boards as cards, like a file browser. The editor opens the last board by default; the
// "Boards" link at the top of the side panel (or #boards in the address) comes here.
const homeShown = () => !$('home').hidden;
let homeUrls = [];

function showHome(on) {
  if (on === homeShown() && on === document.body.classList.contains('home-mode')) { if (on) renderHome(); return; }
  if (on) { saveNow(); if (editing) stopEditing(); clearSelection(); }
  document.body.classList.toggle('home-mode', on);
  $('home').hidden = !on;
  placeBrand();
  if (on) {
    renderHome();
    if (location.hash !== '#boards') history.pushState(null, '', '#boards');
  } else if (location.hash === '#boards') {
    history.pushState(null, '', location.pathname + location.search);
  }
}

const deviceLabel = (id) => { const d = deviceById(id); return d?.family === 'iphone' ? 'iPhone' : d?.name || id; };

async function renderHome() {
  const grid = $('homeGrid');
  const all = await listBoards();
  for (const u of homeUrls) URL.revokeObjectURL(u);
  homeUrls = [];
  grid.innerHTML = '';
  const add = el('button', 'board-card new-card', `<span class="new-plus">${PLUS}</span><span>New board</span>`);
  add.type = 'button';
  add.onclick = () => newBoard();
  grid.appendChild(add);
  for (const b of all) {
    const doc = b.doc;
    const card = el('article', 'board-card');
    card.dataset.board = b.id;
    if (b.id === currentBoard?.id) card.classList.add('current');
    const shots = (doc.groups || []).flatMap(g => g.shots || []);
    const preview = el('button', 'board-preview');
    preview.type = 'button';
    preview.setAttribute('aria-label', `Open ${boardName(b)}`);
    const bg = doc.style?.bg1 || '#F2EEEA';
    preview.style.setProperty('--bg', bg);
    const [r, g, b2] = (bg.match(/[0-9a-f]{2}/gi) || ['f2', 'ee', 'ea']).map(h => parseInt(h, 16));
    preview.style.color = 0.299 * r + 0.587 * g + 0.114 * b2 > 140 ? 'rgba(18,18,18,.45)' : 'rgba(255,255,255,.6)';   // readable on the board's own ground
    for (const h of imageHashesOf(doc).slice(0, 3)) {
      const blob = await blobForHash(h);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      homeUrls.push(url);
      const img = el('img');
      img.alt = ''; img.src = url; img.loading = 'lazy';
      preview.appendChild(img);
    }
    if (!preview.childElementCount) preview.innerHTML = '<span class="preview-empty">No screenshots yet</span>';
    preview.onclick = () => openBoard(b.id);
    const info = el('div', 'board-card-info', '<div class="board-card-name"></div><div class="board-card-meta"></div>');
    info.querySelector('.board-card-name').textContent = boardName(b);
    const devices = [...new Set((doc.groups || []).map(g => deviceLabel(g.device)))].join(' · ');
    const langs = (doc.langs || []).length;
    info.querySelector('.board-card-meta').textContent = [
      devices, `${shots.length} screen${shots.length === 1 ? '' : 's'}`, langs > 1 ? `${langs} languages` : '', `edited ${relTime(b.updatedAt)}`,
    ].filter(Boolean).join(' · ');
    const more = el('button', 'board-more', ICON.more);
    more.type = 'button'; more.title = 'Board options'; more.setAttribute('aria-label', `Options for ${boardName(b)}`);
    more.onclick = (e) => { e.stopPropagation(); openCardMenu(b.id, more); };
    card.append(preview, info, more);
    grid.appendChild(card);
  }
  renderStatusLine();
}

let cardMenuFor = null;
function openCardMenu(id, anchor) {
  cardMenuFor = id;
  const menu = $('cardMenu');
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(innerWidth - 232, r.right - 220))}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.showPopover();
}

async function renameFromCard(id) {
  const card = document.querySelector(`.board-card[data-board="${id}"]`);
  const nameEl = card?.querySelector('.board-card-name');
  if (!nameEl) return;
  const input = el('input', 'board-card-input');
  input.type = 'text'; input.maxLength = 80; input.value = nameEl.textContent;
  input.setAttribute('aria-label', 'Board name');
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    if (save && input.value.trim() && input.value.trim() !== nameEl.textContent) await renameBoardById(id, input.value);
    else renderHome();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

let titleTyping = false;   // the user is mid-rename in the side panel: don't overwrite what they type
/** The board name at the top of the side panel. */
function renderBoardChrome() {
  if (!titleTyping) $('boardTitle').value = currentBoard?.name || 'Untitled board';
  renderSyncControls();
}

function renderSyncControls() {
  if (!$('syncBox')) return;
  const st = sync?.status || { state: 'off' };
  $('syncToggle').setAttribute('aria-pressed', String(!!sync?.enabled));
  $('syncDelete').hidden = !sync?.enabled && st.state !== 'synced';
  const usage = st.usage ? ` · ${(st.usage.bytes / 1024 ** 2).toFixed(st.usage.bytes < 1024 ** 2 * 10 ? 1 : 0)} MB of ${Math.round(st.usage.limit / 1024 ** 3)} GB` : '';
  const note = !sync?.enabled ? (st.state === 'error' ? st.message : 'Off. Boards are saved in this browser only.')
    : st.state === 'error' ? st.message
    : st.state === 'offline' ? 'Offline. Changes sync when you’re back.'
    : st.state === 'syncing' ? `Syncing…${usage}`
    : st.state === 'synced' ? `End-to-end encrypted · synced ${relTime(st.at)}${usage}` : 'End-to-end encrypted.';
  $('syncNote').textContent = note;
  $('homeSync').textContent = !saving ? 'This window can’t save boards. Use Export backup to keep your work.'
    : state.licensed && sync?.enabled ? `Saved in this browser and synced across your browsers${st.state === 'synced' ? ` · ${relTime(st.at)}` : st.state === 'error' ? ` · ${st.message}` : ''}`
    : 'Saved in this browser.';
}

function setupBoards() {
  $('boardTitle').addEventListener('input', () => { titleTyping = true; });
  $('boardTitle').addEventListener('blur', () => { titleTyping = false; renderBoardChrome(); });
  $('boardTitle').addEventListener('change', (e) => { titleTyping = false; if (currentBoard) renameBoardById(currentBoard.id, e.target.value); });
  $('boardTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });
  $('toBoards').onclick = () => showHome(true);
  $('homeNew').onclick = () => newBoard();
  $('homeImport').onclick = () => $('backupFile').click();
  $('backupFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
  $('cardMenu').addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const id = cardMenuFor;
    if (!a || !id) return;
    $('cardMenu').hidePopover();
    if (a === 'open') openBoard(id);
    else if (a === 'rename') renameFromCard(id);
    else if (a === 'duplicate') duplicateBoardById(id);
    else if (a === 'export') exportBackupById(id);
    else if (a === 'delete') deleteBoardById(id);
  });
  addEventListener('popstate', async () => {
    if (location.hash === '#boards') showHome(true);
    else if (homeShown()) {
      if (currentBoard) showHome(false);
      else { const all = await listBoards(); if (all.length) openBoard(all[0].id); else newBoard({ device: defaultDevice() }); }
    }
  });
  $('syncToggle').onclick = async () => {
    if (!saving) return toast('This window can’t save boards, so it can’t sync them either.');
    await sync.setEnabled(!sync.enabled);
    renderSyncControls();
  };
  $('syncDelete').onclick = async () => {
    if (!confirm('Delete everything synced for your license key from the server? Boards stay saved in this browser, and sync turns off here. Your other browsers stop syncing too.')) return;
    try { await sync.deleteRemote(); toast('Synced data deleted. Sync is off.'); }
    catch (e) { toast(e.message || 'Couldn’t delete synced data.'); }
    renderSyncControls();
  };
  // Save before the tab goes away; the debounce would otherwise lose the last half second.
  addEventListener('pagehide', () => { saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  // Another tab saved this board: show its version unless this tab is mid-edit.
  channel?.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'saved' && m.tab !== TAB) onBoardChanged(m.id, 'changed');
  });
  setInterval(renderStatusLine, 60_000);
}

// Desktop editor: the brand and Add screenshots head the side panel, as one floating card. Phones
// and the Boards page: they sit in the top bar.
const narrowMq = matchMedia('(max-width: 860px)');
function placeBrand() {
  const inBar = narrowMq.matches || document.body.classList.contains('home-mode');
  if (inBar) document.querySelector('.topbar').prepend($('brandBox'));
  else $('sidePanel').prepend($('brandBox'));
}

/** Called when another tab or sync changed a saved board. */
async function onBoardChanged(id, how) {
  if (homeShown()) {   // the Boards page shows them all: just redraw it
    if (how === 'removed' && id === currentBoard?.id) currentBoard = null;
    renderHome();
    return;
  }
  if (how === 'removed' && id === currentBoard?.id) {
    toast('This board was deleted in another browser.');
    currentBoard = null;
    const rest = await listBoards();
    if (rest.length) await openBoard(rest[0].id); else await newBoard({ device: defaultDevice() });
    return;
  }
  if (id === currentBoard?.id && how === 'changed') {
    if (saveTimer || editing || Date.now() - lastEditAt < 1500) {   // mid-edit here: apply it once things settle
      clearTimeout(onBoardChanged.retry);
      onBoardChanged.retry = setTimeout(() => onBoardChanged(id, how), 1600);
      return;
    }
    const rec = await boardStore.get(id);
    if (!rec?.doc) return;
    currentBoard.name = boardName(rec);   // a rename alone changes only the name
    if (JSON.stringify(rec.doc) !== lastSavedJson || state.shots.some(s => s.missing)) {   // or captures just arrived
      const keepFocus = { ...focus };
      await hydrateBoard(rec.doc);
      if (state.groups.some(g => g.id === keepFocus.group)) { Object.assign(focus, keepFocus); refresh(); }
    }
  }
  renderBoardChrome();
}

/**
 * After a sync, if this browser only has an untouched starter board open, open the most recently
 * edited synced board instead and drop the starter.
 */
async function leaveStarterBoard() {
  if (!currentBoard || saveTimer || editing || homeShown()) return;
  const cur = await boardStore.get(currentBoard.id);
  if (cur && !cur.pristine) return;
  const other = (await listBoards()).find(b => b.id !== currentBoard.id && !b.pristine);
  if (!other) return;
  const starter = currentBoard.id;
  await openBoard(other.id);
  if (cur && !cur.remoteVersion) await boardStore.delete(starter);
  renderBoardChrome();
}

/** Opens the last board, or makes the first one from what boot set up. Returns true if a board was found. */
async function setupSaving() {
  saving = await openStore();
  if (!saving) {
    setSaveStatus('saved');
    toast('This window can’t save boards (private browsing?). Use Export backup to keep your work.', true);
    currentBoard = { id: crypto.randomUUID(), name: 'Untitled board', createdAt: Date.now() };
    return false;
  }
  askPersistence();
  sync = createSync({
    licenseKey: () => (state.licensed ? storedLicenseKey() : ''),
    isBusy: (id) => id === currentBoard?.id && (!!saveTimer || !!editing || Date.now() - lastEditAt < 1500),
    flush: () => saveNow(),
    boardChanged: (id, how) => onBoardChanged(id, how),
    status: (st) => { renderStatusLine(); if (st.state === 'synced') leaveStarterBoard(); },
  });
  const all = await listBoards();
  const wanted = await metaStore.get('current').catch(() => null);
  const pick = all.find(b => b.id === wanted) || all[0];
  if (pick) {
    try {
      await hydrateBoard(pick.doc);
      currentBoard = { id: pick.id, name: boardName(pick), createdAt: pick.createdAt };
    } catch (e) {
      toast(e.message, true);
      currentBoard = { id: crypto.randomUUID(), name: 'Untitled board', createdAt: Date.now() };
    }
  } else {
    currentBoard = { id: crypto.randomUUID(), name: 'Untitled board', createdAt: Date.now() };
  }
  await metaStore.set('current', currentBoard.id).catch(() => {});
  renderBoardChrome();
  cleanupImages().catch(() => {});
  if (location.hash === '#boards') showHome(true);
  return !!pick;
}

// ---------- Boot ----------
async function boot() {
  const fromCheckout = new URLSearchParams(location.search).has('checkout');   // read before setupLicense tidies the address
  // Konva draws text on canvas, so fonts must be loaded before the first render.
  await Promise.all([
    'Inter:400', 'Inter:600', 'Source Serif 4:500', 'Source Sans 3:400', 'Source Sans 3:600',
  ].map(s => { const [f, w] = s.split(':'); return document.fonts.load(`${w} 40px "${f}"`, 'AaČć'); })).catch(() => {});
  setupInputs();
  setupInlineEditor();
  const firstLaunch = setupDevice(availableFinishes());
  await Promise.all(state.devices.map(id => loadFrame(id, state.colors[id])));   // only the frames in use
  state.style = { ...themePatch(templateById('paper')), layout: 'top', headlineScale: 1 };
  setupBoard();
  syncToolbar();
  setupDropzone();
  setupTranslate();
  // Desktop: the brand and Add screenshots head the side panel, as one floating card. Phones: they
  // stay in the top bar, and the panel is a strip of chips under it.
  placeBrand();
  narrowMq.addEventListener('change', placeBrand);
  setupLicense();
  $('exportBtn').onclick = exportZip;
  refresh({ fit: true });
  const hadBoard = await setupSaving();
  setupBoards();
  sync?.init();
  // First visit: ask what the screenshots are for (not when coming back from checkout).
  if (firstLaunch && !hadBoard && !fromCheckout) openDeviceDialog('first');
  window.__dss = { state, ready: true, saveNow, board: () => currentBoard, sync: () => sync }; // used by the headless test
}
// The page stays hidden (html.booting) until the saved board is drawn, so a refresh doesn't flash the
// starter design or toolbars in their first-pass positions. Shown even if boot fails.
boot().finally(() => requestAnimationFrame(() => document.documentElement.classList.remove('booting')));
