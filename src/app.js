/* global Konva, JSZip */
import { PRO, WATERMARK_TEXT, LANGUAGES } from './config.js';
import { FAMILIES, DEVICES, TARGETS, SCREENS, targetById, loadFrames, getFrame } from './devices.js';
import { TEMPLATES, LAYOUTS, FONTS, templateById } from './templates.js';
import { buildComposition } from './render.js';
import { canvasToRgbPng } from './png.js';
import { checkLicense, claimCheckout, storedLicenseKey, forgetLicense } from './license.js';
import { translateTexts } from './translate.js';
import { makeSampleScreenshot, SAMPLE_SHOTS } from './sample.js';

const $ = (id) => document.getElementById(id);
const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = { del: svg('M5 5l6 6M11 5l-6 6') };
// A target is one App Store size: a device display such as "duo/inner" or "iphone-air/main".
const activeTargets = () => TARGETS.filter(t => state.devices.includes(t.device.id));
const sizeOf = (tid) => targetById(tid).display.size[state.pose[tid]];
const targetLabel = (t) => t.display.label ? `${t.device.name} · ${t.display.label}` : t.device.name;

const state = {
  shots: [],            // { id, name, image, images: { [screen]: img }, variants?, style?: overrides, text: { [lang]: { headline, subheadline } } }
  selection: new Set(), // shot ids; empty means "all screenshots" for toolbar edits
  baseLang: 'en',
  langs: ['en'],
  style: null,
  licensed: false,
  devices: ['duo'],     // devices to make screenshots for, in board order; at most one per family
  models: {},           // family id -> the model last picked, so ticking iPhone again brings it back
  pose: Object.fromEntries(TARGETS.map(t => [t.id, 'portrait'])),   // App Store Connect takes either orientation per size
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
    : sel.length === 1 ? `Screenshot ${state.shots.indexOf(sel[0]) + 1}` : `${sel.length} selected`;
  $('scopeLabel').classList.toggle('on', sel.length > 0);
  renderScreenRows(sel.length === 1 ? sel[0] : null);
}

// Style popover: one row per screen in use, to give the selected screenshot its own capture there
// (say, a real cover-screen capture for the Duo's outer display, or an iPhone capture).
function renderScreenRows(one) {
  const box = $('screenRows');
  box.innerHTML = '';
  const screens = [...new Set(activeTargets().map(t => t.display.screen))];
  if (screens.length < 2 && !one?.images?.[screens[0]]) return;
  for (const screen of screens) {
    const row = el('label', 'cell row-cell chevron');
    row.innerHTML = '<span></span><span class="value"></span><input type="file" accept="image/png,image/jpeg,image/webp" hidden>';
    row.firstChild.textContent = SCREENS[screen];
    row.children[1].textContent = !one ? 'Select one screenshot' : one.images?.[screen] ? 'Own image' : one.variants?.[screen] ? 'Sample capture' : 'Same image';
    row.setAttribute('aria-disabled', String(!one));
    row.title = `Use a different capture on the ${SCREENS[screen]}`;
    const input = row.querySelector('input');
    input.dataset.screen = screen;
    input.disabled = !one;
    input.onchange = async (e) => {
      if (one && e.target.files[0]) { one.images = { ...(one.images || {}), [screen]: await loadImage(e.target.files[0]) }; refresh(); }
      e.target.value = '';
    };
    box.appendChild(row);
  }
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
    b.setAttribute('aria-pressed', String(activeStyle().template.id === t.id));
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
  $('fontSelect').value = st.font;
  $('headlineScale').value = st.headlineScale;
}

// ---------- Text ----------
function textFor(shot, lang) {
  return shot.text[lang] || shot.text[state.baseLang] || { headline: '', subheadline: '' };
}

// The capture shown on a screen: the screenshot's own image for it, then a sample capture in the
// matching pose (iPhones borrow the Duo's phone-shaped outer captures), then the main image.
function imageFor(shot, screen, pose) {
  const v = shot.variants || {};
  const pick = (k) => v[k]?.[pose] || v[k]?.portrait;
  return shot.images?.[screen] || v[screen]?.[pose] || (screen === 'iphone' && pick('duo/outer')) || shot.image;
}

function compositionProps(shot, tid, lang) {
  const t = textFor(shot, lang);
  const target = targetById(tid), pose = state.pose[tid];
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
let editing = null;                   // { shotId, lang, target, key }

const pad2 = (n) => String(n).padStart(2, '0');
const el = (tag, cls, html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; e.innerHTML = html; return e; };
const ICON = {
  dup: svg('M5.5 5.5V4a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 13.5 4v5A1.5 1.5 0 0 1 12 10.5h-1.5M4 5.5h5A1.5 1.5 0 0 1 10.5 7v5A1.5 1.5 0 0 1 9 13.5H4A1.5 1.5 0 0 1 2.5 12V7A1.5 1.5 0 0 1 4 5.5z'),
  left: svg('M10 4l-4 4 4 4'), right: svg('M6 4l4 4-4 4'), del: svg('M5 5l6 6M11 5l-6 6'),
};

function applyView() {
  $('boardWorld').style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
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
  const w = world.offsetWidth, h = world.offsetHeight;
  if (!w || !h) return;
  const narrow = matchMedia('(max-width: 860px)').matches;
  const top = narrow ? 64 : 76, bottom = narrow ? 92 : 104, side = narrow ? 16 : 48;
  const bw = board.clientWidth - side * 2, bh = board.clientHeight - top - bottom;
  // Phones stack the cards in one column, so fit the width and let people pan down.
  view.z = Math.min(1.25, Math.max(0.08, narrow ? bw / w : Math.min(bw / w, bh / h)));
  view.x = side + (bw - w * view.z) / 2;
  view.y = top + Math.max(0, (bh - h * view.z) / 2);
  applyView();
}

function buildStructure() {
  for (const f of frames.values()) f.stage.destroy();
  frames.clear();
  const world = $('boardWorld');
  world.innerHTML = '';
  for (const lang of state.langs) {
    const row = el('section', 'lang-row');
    row.dataset.lang = lang;
    const head = el('header', 'row-head', '<span class="row-name"></span><span class="row-sub"></span>');
    head.querySelector('.row-name').textContent = langName(lang);
    head.querySelector('.row-sub').textContent = lang === state.baseLang ? 'Base language' : 'Translated';
    if (lang !== state.baseLang) {
      const rm = el('button', 'row-remove', ICON.del);
      rm.type = 'button'; rm.title = `Remove ${langName(lang)}`; rm.setAttribute('aria-label', rm.title);
      rm.onclick = () => removeLang(lang);
      head.appendChild(rm);
    }
    const cards = el('div', 'row-shots');
    state.shots.forEach((shot, i) => {
      const card = el('article', 'shot-card');
      card.dataset.id = shot.id;
      card.innerHTML = `<header class="card-head"><span class="card-num">${pad2(i + 1)}</span><span class="card-tag"></span>
        <span class="card-tools">
          <button type="button" data-a="dup" title="Duplicate as a variation" aria-label="Duplicate">${ICON.dup}</button>
          <button type="button" data-a="left" title="Move left" aria-label="Move left" ${i === 0 ? 'disabled' : ''}>${ICON.left}</button>
          <button type="button" data-a="right" title="Move right" aria-label="Move right" ${i === state.shots.length - 1 ? 'disabled' : ''}>${ICON.right}</button>
          <button type="button" data-a="del" title="Remove" aria-label="Remove">${ICON.del}</button>
        </span></header><div class="card-frames"></div>`;
      card.querySelector('.card-tools').onclick = (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'dup') duplicateShot(shot.id);
        else if (a === 'left') moveShot(shot.id, -1);
        else if (a === 'right') moveShot(shot.id, 1);
        else if (a === 'del') deleteShot(shot.id);
      };
      const framesEl = card.querySelector('.card-frames');
      for (const t of activeTargets()) {
        const size = sizeOf(t.id);
        const fr = el('div', 'frame', '<div class="frame-stage"></div><div class="text-hits"></div>');
        fr.dataset.target = t.id;
        if (t.device.id === 'duo') fr.dataset.display = t.display.id;
        fr.style.width = `${Math.round(size.width * K)}px`;
        fr.style.height = `${Math.round(size.height * K)}px`;
        const wrap = el('figure', 'frame-wrap');
        wrap.appendChild(fr);
        if (lang === state.baseLang) {
          const cap = el('figcaption', 'frame-cap');
          cap.textContent = `${targetLabel(t)} · ${size.width} × ${size.height}`;
          wrap.appendChild(cap);
        }
        framesEl.appendChild(wrap);
        const stage = new Konva.Stage({ container: fr.firstChild, width: Math.round(size.width * K), height: Math.round(size.height * K) });
        const layer = new Konva.Layer({ listening: false });
        layer.scale({ x: K, y: K });
        stage.add(layer);
        frames.set(`${shot.id}:${lang}:${t.id}`, { stage, layer, el: fr, shotId: shot.id, lang, target: t.id, pr: 0 });
      }
      cards.appendChild(card);
    });
    row.append(head, cards);
    world.appendChild(row);
  }
  schedulePixelRatio();
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
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; drawAll(); });
}

function drawAll() {
  for (const f of frames.values()) {
    const shot = state.shots.find(s => s.id === f.shotId);
    if (!shot) continue;
    const mine = editing && editing.shotId === f.shotId && editing.lang === f.lang && editing.target === f.target;
    f.nodes = buildComposition(f.layer, sizeOf(f.target), { ...compositionProps(shot, f.target, f.lang), hide: mine ? editing.key : null });
    placeTextHits(f);
  }
  if (editing) positionEditor();
}

function renderBoard({ fit = false } = {}) {
  const has = state.shots.length > 0;
  $('empty').hidden = has;
  for (const id of ['board', 'dock', 'boardTools', 'zoomTools']) $(id).hidden = !has;
  $('exportBtn').disabled = !has;
  $('langLabel').textContent = state.langs.length > 1 ? `${state.langs.length} languages` : 'Translate';
  const targets = activeTargets();
  $('sizeInfo').textContent = targets.length > 2 ? `${targets.length} App Store sizes`
    : targets.map(t => `${t.display.label || t.device.name} ${sizeOf(t.id).width} × ${sizeOf(t.id).height}`).join(' · ');
  if (!has) return;
  const key = JSON.stringify([state.shots.map(s => s.id), state.langs, state.devices, state.pose]);
  if (key !== structureKey) { buildStructure(); structureKey = key; requestAnimationFrame(schedulePixelRatio); }
  syncSelectionUI();
  drawAll();
  if (fit) requestAnimationFrame(fitBoard);
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
  const i = state.shots.findIndex(s => s.id === id);
  const s = state.shots[i];
  const copy = { ...s, id: nextId++, text: structuredClone(s.text), style: { ...(s.style || {}) } };
  state.shots.splice(i + 1, 0, copy);
  state.selection = new Set([copy.id]);
  refresh();
  toast('Duplicated. Change its layout, theme or text to make a variation.');
}
function moveShot(id, dir) {
  const i = state.shots.findIndex(s => s.id === id), j = i + dir;
  if (j < 0 || j >= state.shots.length) return;
  [state.shots[i], state.shots[j]] = [state.shots[j], state.shots[i]];
  refresh();
}
function deleteShot(id) {
  if (editing?.shotId === id) stopEditing();
  state.shots = state.shots.filter(s => s.id !== id);
  state.selection.delete(id);
  refresh();
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
  ed.value = textFor(shot, f.lang)[key] || '';
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
    shot.text[editing.lang] = { ...textFor(shot, editing.lang), [editing.key]: ed.value.replace(/\n/g, ' ') };
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
    if (e.target.closest('.text-hit, .card-tools, .row-remove, .inline-editor')) return;
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
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);   // stays in the browser; nothing is uploaded
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read ' + file.name));
    img.src = url;
  });
}

const DEFAULT_COPY = [
  ['Built for the big screen', 'Everything you need, side by side on iPhone Duo.'],
  ['Pick up where you left off', 'Fold or unfold — your place follows you.'],
  ['Find what you love', 'Smart search that keeps up with you.'],
  ['Made to feel at home', 'Thoughtful details on both displays.'],
  ['Ready on day one', 'Optimized for iPhone Duo.'],
];

async function addFiles(files) {
  const images = [...files].filter(f => /^image\//.test(f.type));
  if (!images.length) return toast('Please drop PNG or JPEG screenshots.');
  for (const f of images) {
    try {
      const img = await loadImage(f);
      const [headline, subheadline] = DEFAULT_COPY[state.shots.length % DEFAULT_COPY.length];
      state.shots.push({ id: nextId++, name: f.name, image: img, images: {}, text: { [state.baseLang]: { headline, subheadline } } });
    } catch (e) { toast(e.message); }
  }
  refresh({ fit: true });
}

const loadUrl = (src) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

// Loads the real sample captures; returns [] if they aren't in the repo, so the generated sample is used.
async function loadSampleShots() {
  const shots = [];
  for (const s of SAMPLE_SHOTS) {
    const variants = {};
    for (const [screen, poses] of Object.entries(s.captures)) {
      variants[screen] = {};
      for (const [pose, src] of Object.entries(poses)) variants[screen][pose] = await loadUrl(src);
    }
    const image = variants['duo/inner']?.landscape || variants['duo/inner']?.portrait || variants['duo/outer']?.portrait;
    if (!image) return [];
    shots.push({ id: nextId++, name: 'HearHere sample', image, images: {}, variants,
      text: { [state.baseLang]: { headline: s.headline, subheadline: s.subheadline } } });
  }
  return shots;
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
  const addSample = async () => {
    const shots = await loadSampleShots();
    if (shots.length) {
      // The captures were taken unfolded in landscape, so show the inner display that way.
      if (shots.some(s => s.variants['duo/inner']?.landscape)) state.pose['duo/inner'] = 'landscape';
      state.shots.push(...shots);
      syncDeviceInputs();
      return refresh({ fit: true });
    }
    const { width, height } = sizeOf(activeTargets()[0].id);   // match the first size, so nothing is cropped
    const blob = await makeSampleScreenshot(width, height);
    addFiles([new File([blob], 'sample-screenshot.png', { type: 'image/png' })]);
  };
  $('emptySample').onclick = addSample;
  $('emptyAdd').onclick = () => $('fileInput').click();
}

// ---------- Text & style inputs ----------
function setupInputs() {
  $('headlineScale').oninput = (e) => applyStyle({ headlineScale: +e.target.value });
  for (const k of ['bg1', 'bg2', 'textColor']) $(k).oninput = (e) => applyStyle({ [k]: e.target.value });
  const fs = $('fontSelect');
  for (const [k, f] of Object.entries(FONTS)) fs.add(new Option(f.label, k));
  fs.onchange = (e) => applyStyle({ font: e.target.value });
  window.addEventListener('resize', () => renderBoard());
}

// ---------- Devices: which ones, their finish and pose ----------
const POSE_ICON = {
  portrait: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="3" width="8" height="14" rx="2.2"/></svg>',
  landscape: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="6" width="14" height="8" rx="2.2"/></svg>',
};

function syncDeviceInputs() {
  const on = DEVICES.filter(d => state.devices.includes(d.id));
  $('devicesLabel').textContent = on.map(d => d.name).join(' + ');
  renderDeviceList();
}

// A row per kind of device with a switch. Turning one on shows its details right under it:
// the model (iPhone), the finish and, for the Duo, each display's orientation.
function renderDeviceList() {
  const list = $('deviceList');
  list.innerHTML = '';
  for (const fam of FAMILIES) {
    const models = DEVICES.filter(d => d.family === fam.id && state.available[d.id]?.length);
    if (!models.length) continue;
    const d = models.find(m => state.devices.includes(m.id));
    const card = el('section', 'device-card' + (d ? ' on' : ''));
    card.dataset.family = fam.id;
    card.innerHTML = `<label class="device-head"><span class="device-text"><span class="device-name"></span>
      <span class="device-note"></span></span><input type="checkbox" role="switch" class="switch"></label>`;
    const box = card.querySelector('input');
    box.checked = !!d;
    box.disabled = !!d && state.devices.length === 1;   // keep at least one
    box.setAttribute('aria-label', fam.name);
    box.onchange = () => toggleFamily(fam.id, box.checked);
    card.querySelector('.device-name').textContent = fam.name;
    const size = d?.displays.length === 1 ? d.displays[0].size.portrait : null;
    card.querySelector('.device-note').textContent = !d ? fam.note : size ? `${d.note} · ${size.width} × ${size.height}` : d.note;
    if (box.disabled) card.querySelector('.device-head').title = 'At least one device stays on';
    if (d) card.appendChild(deviceDetails(d, models));
    list.appendChild(card);
  }
  const n = activeTargets().length;
  $('deviceSummary').textContent = `${n} App Store size${n > 1 ? 's' : ''} per screenshot`;
}

function deviceDetails(d, models) {
  const box = el('div', 'device-details');
  if (models.length > 1) {
    const chips = el('div', 'model-chips');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', 'Model');
    for (const m of models) {
      const b = el('button');
      b.type = 'button'; b.dataset.model = m.id; b.textContent = m.short;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(m.id === d.id));
      b.title = `${m.name} · ${m.note}`;
      b.onclick = () => chooseModel(d.family, m.id);
      chips.appendChild(b);
    }
    box.appendChild(chips);
  }
  const line = el('div', 'device-line');
  const colors = state.available[d.id];
  const sw = el('span', 'swatches');
  sw.dataset.device = d.id;
  for (const c of colors) {
    const b = el('button');
    b.type = 'button'; b.dataset.color = c.id; b.title = c.name; b.setAttribute('aria-label', c.name);
    b.setAttribute('aria-pressed', String(state.colors[d.id] === c.id));
    b.style.setProperty('--swatch', c.swatch);
    b.onclick = () => { state.colors[d.id] = c.id; syncDeviceInputs(); renderBoard(); };
    sw.appendChild(b);
  }
  const name = el('span', 'finish-name');
  name.textContent = colors.find(c => c.id === state.colors[d.id])?.name || '';
  line.append(sw, name);
  for (const x of d.displays) {
    if (x.poses?.length === 1) continue;   // iPhones are always portrait
    const tid = `${d.id}/${x.id}`;
    const seg = el('div', 'segmented');
    seg.dataset.pose = tid;
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', `${x.label} display orientation`);
    for (const v of ['portrait', 'landscape']) {
      const b = el('button', '', POSE_ICON[v]);
      b.type = 'button'; b.dataset.v = v; b.setAttribute('aria-label', v);
      b.title = `${x.label} display: ${v}, ${x.size[v].width} × ${x.size[v].height}`;
      b.setAttribute('aria-pressed', String(state.pose[tid] === v));
      b.onclick = () => { state.pose[tid] = v; syncDeviceInputs(); renderBoard({ fit: true }); };
      seg.appendChild(b);
    }
    const l = el('span', 'pose-label');
    l.textContent = x.label;
    line.append(l, seg);
  }
  box.appendChild(line);
  return box;
}

function setDevices(ids) {
  state.devices = DEVICES.map(d => d.id).filter(id => ids.includes(id));
  syncDeviceInputs();
  syncToolbar();
  renderBoard({ fit: true });
}

function toggleFamily(fam, on) {
  const others = state.devices.filter(id => DEVICES.find(d => d.id === id).family !== fam);
  if (on) setDevices([...others, state.models[fam]]);
  else if (others.length) setDevices(others);
}

function chooseModel(fam, id) {
  state.models[fam] = id;
  toggleFamily(fam, true);
}

function setupDevice(available) {
  state.available = available;
  for (const [id, colors] of Object.entries(available)) state.colors[id] = colors[0].id;
  for (const fam of FAMILIES) state.models[fam.id] = DEVICES.find(d => d.family === fam.id && available[d.id])?.id;
  state.devices = state.devices.filter(id => available[id]);
  if (!state.devices.length) state.devices = [Object.keys(available)[0] || 'duo'];
  syncDeviceInputs();
}

// ---------- Translate (Pro) ----------
const langName = (code) => LANGUAGES.find(l => l[0] === code)?.[1] || code;

function renderLangChecks() {
  const box = $('langChecks');
  box.innerHTML = '';
  for (const [code, name] of LANGUAGES) {
    if (code === state.baseLang) continue;
    const l = document.createElement('label');
    l.className = 'lang-check' + (state.langs.includes(code) ? ' done' : '');
    l.innerHTML = '<input type="checkbox"><span></span>';
    l.querySelector('input').value = code;
    l.querySelector('span').textContent = name;
    box.appendChild(l);
  }
  syncTranslateButton();
}

function selectedTargets() {
  return [...$('langChecks').querySelectorAll('input:checked')].map(i => i.value);
}

function syncTranslateButton() {
  const n = selectedTargets().length;
  $('translateCount').textContent = n ? `${n} language${n > 1 ? 's' : ''}` : 'Pick languages';
  $('translateBtn').disabled = !n;
  $('translateBtn').textContent = state.licensed ? 'Translate' : 'Get Pro to translate';
}

function setupTranslate() {
  renderLangChecks();
  $('langChecks').onchange = syncTranslateButton;
  $('translateBtn').onclick = async () => {
    if (!state.licensed) { $('langPop').hidePopover(); $('licensePop').showPopover(); return; }
    if (!state.shots.length) return toast('Add screenshots first.');
    const targets = selectedTargets();
    if (targets.length > 12) { $('translateStatus').textContent = 'Pick up to 12 languages at a time.'; return; }
    const texts = state.shots.flatMap(s => { const t = textFor(s, state.baseLang); return [t.headline, t.subheadline]; });
    $('translateBtn').disabled = true;
    $('translateStatus').textContent = `Translating into ${targets.length} language${targets.length > 1 ? 's' : ''}…`;
    try {
      const { translations, failed, usage } = await translateTexts(texts, targets, state.baseLang, storedLicenseKey());
      for (const [lang, out] of Object.entries(translations)) {
        state.shots.forEach((s, i) => { s.text[lang] = { headline: out[i * 2], subheadline: out[i * 2 + 1] }; });
        if (!state.langs.includes(lang)) state.langs.push(lang);
      }
      const added = Object.keys(translations);
      renderLangChecks();
      refresh({ fit: true });
      const left = usage ? ` ${usage.limit - usage.runs} of ${usage.limit} left this month.` : '';
      $('translateStatus').textContent = (added.length ? `Added ${added.map(langName).join(', ')}. Review the text: exports include every language.` : '')
        + (failed.length ? ` Couldn't translate ${failed.map(langName).join(', ')}; try again.` : '') + left;
    } catch (e) {
      $('translateStatus').textContent = e.message;
    } finally {
      syncTranslateButton();
    }
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
// "iPhone-Duo-inner-2853x2007", "iPhone-Air-1260x2736": one folder per App Store size.
const folderName = (t) => {
  const { width, height } = sizeOf(t.id);
  return `${t.device.name.replace(/\s+/g, '-')}${t.display.label ? '-' + t.display.id : ''}-${width}x${height}`;
};

async function renderToPng(shot, tid, lang) {
  const size = sizeOf(tid);
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
  for (const lang of state.langs) state.shots.forEach((s, i) => targets.forEach(t => jobs.push({ lang, s, i, t })));
  showProgress(0, jobs.length);
  try {
    let done = 0;
    for (const { lang, s, i, t } of jobs) {
      const { width, height } = sizeOf(t.id);
      const blob = await renderToPng(s, t.id, lang);
      const folder = state.langs.length > 1 ? `${lang}/` : '';
      zip.file(`${folder}${folderName(t)}/${String(i + 1).padStart(2, '0')}.png`, blob);
      showProgress(++done, jobs.length);
      await new Promise(r => setTimeout(r)); // keep UI responsive
    }
    zip.file('README.txt', `App Store screenshots — made with HearHere Studio\n\n` +
      targets.map(t => `${targetLabel(t)} (${t.device.note}): ${folderName(t)}`).join('\n') +
      `\n\nUpload each folder to the matching device size in App Store Connect (1–10 per size).\nPNG, RGB, no alpha channel.\n`);
    const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = 'app-store-screenshots.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    toast(`Exported ${jobs.length} screenshots${state.licensed ? '' : ' (with watermark — unlock to remove)'}.`);
    window.__lastExport = { count: jobs.length, bytes: out.size };
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + e.message);
  } finally {
    btn.disabled = state.shots.length === 0;
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

// ---------- Boot ----------
async function boot() {
  // Konva draws text on canvas, so fonts must be loaded before the first render.
  await Promise.all([
    'Inter:400', 'Inter:600', 'Source Serif 4:500', 'Source Sans 3:400', 'Source Sans 3:600',
  ].map(s => { const [f, w] = s.split(':'); return document.fonts.load(`${w} 40px "${f}"`, 'AaČć'); })).catch(() => {});
  const available = await loadFrames();
  setupInputs();
  setupInlineEditor();
  setupDevice(available);
  state.style = { ...themePatch(templateById('paper')), layout: 'top', headlineScale: 1 };
  setupBoard();
  syncToolbar();
  setupDropzone();
  setupTranslate();
  setupLicense();
  $('exportBtn').onclick = exportZip;
  refresh();
  window.__dss = { state, ready: true }; // used by the headless test
}
boot();
