/* global Konva, JSZip */
import { DUO_SIZES, LICENSE, WATERMARK_TEXT, LANGUAGES } from './config.js';
import { DEVICE_COLORS, loadFrames, getFrame } from './frames.js';
import { TEMPLATES, LAYOUTS, FONTS, templateById } from './templates.js';
import { buildComposition } from './render.js';
import { canvasToRgbPng } from './png.js';
import { checkLicense, storedLicenseKey, storeLicenseKey } from './license.js';
import { translateTexts, translateConfigured } from './translate.js';
import { makeSampleScreenshot, SAMPLE_SHOTS } from './sample.js';

const $ = (id) => document.getElementById(id);
const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = { del: svg('M5 5l6 6M11 5l-6 6') };
const DISPLAYS = ['inner', 'outer'];
const sizeOf = (d) => DUO_SIZES[d][state.pose[d]];

const state = {
  shots: [],            // { id, name, image, outerImage, text: { [lang]: { headline, subheadline } } }
  selected: -1,
  baseLang: 'en',
  langs: ['en'],
  activeLang: 'en',
  style: null,
  licensed: false,
  pose: { inner: 'portrait', outer: 'portrait' },   // App Store Connect takes either orientation per display
  deviceColor: DEVICE_COLORS[0].id,
};
let nextId = 1;

function setTemplate(id) {
  const t = templateById(id);
  state.style = { template: t, layout: state.style?.layout || 'peek-left', bg1: t.bg1, bg2: t.bg2, textColor: t.textColor, font: t.font, headlineScale: state.style?.headlineScale || 1 };
  syncStyleInputs();
  renderTemplateGrid();
  renderLayoutGrid();
  renderPreview();
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
    b.setAttribute('aria-pressed', String(state.style?.template.id === t.id));
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
    b.setAttribute('aria-pressed', String(state.style.layout === l.id));
    b.innerHTML = `<svg viewBox="0 0 40 32" aria-hidden="true">${LAYOUT_ICONS[l.id]}</svg>`;
    b.onclick = () => { state.style.layout = l.id; renderLayoutGrid(); renderPreview(); };
    grid.appendChild(b);
  }
}

function syncStyleInputs() {
  $('bg1').value = state.style.bg1;
  $('bg2').value = state.style.bg2;
  $('textColor').value = state.style.textColor;
  $('fontSelect').value = state.style.font;
  $('headlineScale').value = state.style.headlineScale;
}

// ---------- UI: shot list ----------
function textFor(shot, lang = state.activeLang) {
  return shot.text[lang] || shot.text[state.baseLang] || { headline: '', subheadline: '' };
}

function renderShotList() {
  const list = $('shotList');
  list.innerHTML = '';
  state.shots.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = i === state.selected ? 'active' : '';
    li.title = `${i + 1}. ${textFor(s).headline || s.name}`;
    li.tabIndex = 0;
    li.draggable = true;
    li.innerHTML = `<img alt=""><button class="del" data-a="del" title="Remove" aria-label="Remove screenshot ${i + 1}">${ICONS.del}</button>`;
    li.querySelector('img').src = s.thumb || s.image.src;
    li.onclick = (e) => {
      if (e.target.closest('button')?.dataset.a === 'del') { state.shots.splice(i, 1); state.selected = Math.min(state.selected, state.shots.length - 1); }
      else state.selected = i;
      refresh();
    };
    // Reorder by dragging, or with Alt + arrow keys.
    li.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.selected = i; refresh(); }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); moveShot(i, i + (e.key === 'ArrowLeft' ? -1 : 1)); }
    };
    li.ondragstart = (e) => { e.dataTransfer.setData('text/x-shot', String(i)); e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); };
    li.ondragend = () => li.classList.remove('dragging');
    li.ondragover = (e) => { if (e.dataTransfer.types.includes('text/x-shot')) { e.preventDefault(); e.stopPropagation(); } };
    li.ondrop = (e) => {
      const from = e.dataTransfer.getData('text/x-shot');
      if (from === '') return;
      e.preventDefault(); e.stopPropagation();
      moveShot(+from, i);
    };
    list.appendChild(li);
  });
  requestAnimationFrame(placeIndicator);
}

function moveShot(from, to) {
  if (to < 0 || to >= state.shots.length || from === to) return;
  const [shot] = state.shots.splice(from, 1);
  state.shots.splice(to, 0, shot);
  state.selected = to;
  refresh();
  $('shotList').children[to]?.focus();
}

// Strip thumbnails are the real composition of the inner display, re-rendered shortly after edits.
let thumbStage, thumbTimer;
function scheduleThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(renderThumbs, 150);
}
function renderThumbs() {
  const size = sizeOf('inner');
  const h = 104, k = h / size.height, w = Math.round(size.width * k);   // 52px tall at 2x
  if (!thumbStage) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;';
    document.body.appendChild(host);
    thumbStage = new Konva.Stage({ container: host, width: w, height: h });
    thumbStage.add(new Konva.Layer({ listening: false }));
  }
  const layer = thumbStage.getLayers()[0];
  thumbStage.size({ width: w, height: h });
  layer.scale({ x: k, y: k });
  const imgs = $('shotList').querySelectorAll('img');
  state.shots.forEach((shot, i) => {
    buildComposition(layer, size, { ...compositionProps(shot, 'inner'), watermark: false });
    shot.thumb = thumbStage.toDataURL({ pixelRatio: 1 });
    if (imgs[i]) imgs[i].src = shot.thumb;
  });
  requestAnimationFrame(placeIndicator);
}

// One orange indicator that glides to the selected screenshot instead of a highlight per row.
function placeIndicator() {
  const list = $('shotList'), ind = $('shotIndicator');
  const li = list.children[state.selected];
  ind.classList.toggle('on', !!li);
  if (!li) return;
  ind.style.setProperty('--x', `${li.offsetLeft - list.scrollLeft + li.offsetWidth * 0.3}px`);
  ind.style.setProperty('--w', `${li.offsetWidth * 0.4}px`);
}

function syncTextInputs() {
  const s = state.shots[state.selected];
  $('textFor').textContent = s ? `· ${state.selected + 1}` : '';
  $('outerFile').disabled = !s;
  $('outerValue').textContent = s?.outerImage ? 'Custom image' : s?.variants ? 'Cover capture' : 'Same image';
  $('outerValue').parentElement.setAttribute('aria-disabled', String(!s));
}

function renderLangSelect() {
  const sel = $('langSelect');
  sel.innerHTML = '';
  for (const code of state.langs) {
    const o = document.createElement('option');
    o.value = code; o.textContent = (LANGUAGES.find(l => l[0] === code)?.[1] || code) + (code === state.baseLang ? ' (base)' : '');
    sel.appendChild(o);
  }
  sel.value = state.activeLang;
  $('langLabel').textContent = LANGUAGES.find(l => l[0] === state.activeLang)?.[1] || state.activeLang;
}

// ---------- Preview ----------
const previewStages = {};
function ensurePreviewStages() {
  for (const d of DISPLAYS) {
    if (previewStages[d]) continue;
    const stage = new Konva.Stage({ container: d === 'inner' ? 'stageInner' : 'stageOuter', width: 10, height: 10 });
    const layer = new Konva.Layer({ listening: false });
    stage.add(layer);
    previewStages[d] = { stage, layer };
  }
}

function previewScale() {
  const wrap = document.querySelector('.stage-wrap');
  const cs = getComputedStyle(wrap);
  const gap = parseFloat(getComputedStyle($('previews')).columnGap) || 0;
  const availW = Math.max(200, wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (matchMedia('(max-width: 860px)').matches ? 0 : gap));
  // on narrow screens the stage grows with its content, so cap by the viewport instead
  const narrow = matchMedia('(max-width: 860px)').matches;
  const availH = Math.max(200, narrow ? window.innerHeight * 0.62 : wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 40);
  const inner = sizeOf('inner'), outer = sizeOf('outer');
  // both previews share the same pixel scale so their relative size is honest; narrow screens stack them
  if (narrow) return Math.min(availW / Math.max(inner.width, outer.width), availH / Math.max(inner.height, outer.height));
  return Math.min(availH / Math.max(inner.height, outer.height), availW / (inner.width + outer.width));
}

function compositionProps(shot, display, lang = state.activeLang) {
  const t = textFor(shot, lang);
  return {
    image: shot.variants?.[display]?.[state.pose[display]]
      || (display === 'outer' && shot.outerImage) || shot.image,
    frame: getFrame(state.deviceColor, display, state.pose[display]),
    headline: t.headline, subheadline: t.subheadline,
    style: state.style, watermark: !state.licensed, watermarkText: WATERMARK_TEXT,
  };
}

function renderPreview() {
  const shot = state.shots[state.selected];
  $('empty').hidden = !!shot;
  $('previews').hidden = !shot;
  $('dock').hidden = !shot;
  $('filmstrip').hidden = !shot;
  if (!shot) return;
  ensurePreviewStages();
  const s = previewScale();
  for (const d of DISPLAYS) {
    const p = previewStages[d];
    const size = sizeOf(d);
    $(d + 'Size').textContent = `${size.width} × ${size.height}`;
    p.stage.size({ width: Math.round(size.width * s), height: Math.round(size.height * s) });
    p.stage.scale({ x: s, y: s });
    const nodes = buildComposition(p.layer, size, { ...compositionProps(shot, d), hide: editing?.display === d ? editing.key : null });
    placeTextHits(d, nodes, s);
  }
  if (editing) positionEditor();
  scheduleThumbs();
}

// ---------- Inline text editing ----------
// Each preview gets transparent hit areas over its headline and subheadline. Clicking one opens a
// textarea styled like the rendered text, placed exactly over it; the canvas hides that text meanwhile.
let editing = null;          // { display, key }
const hitRects = {};         // display -> { headline: {x,y,width,height,node}, subheadline: ... }

function placeTextHits(display, nodes, scale) {
  const box = document.querySelector(`.text-hits[data-display="${display}"]`);
  hitRects[display] = {};
  box.innerHTML = '';
  for (const key of ['headline', 'subheadline']) {
    const node = nodes[key];
    const r = node.getClientRect();
    const empty = !node.text();
    const rect = { x: r.x, y: r.y, width: Math.max(r.width, empty ? node.width() * scale : 0), height: Math.max(r.height, node.fontSize() * scale * 1.3), node, scale };
    if (empty && key === 'subheadline') rect.y = nodes.headline.getClientRect().y + nodes.headline.getClientRect().height + 4;
    hitRects[display][key] = rect;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'text-hit' + (empty ? ' empty' : '');
    b.dataset.key = key;
    b.setAttribute('aria-label', `Edit ${key}`);
    if (empty) b.textContent = key === 'headline' ? 'Add headline' : 'Add subheadline';
    Object.assign(b.style, { left: `${rect.x - 6}px`, top: `${rect.y - 4}px`, width: `${rect.width + 12}px`, height: `${rect.height + 8}px` });
    b.onclick = () => startEditing(display, key);
    box.appendChild(b);
  }
}

function startEditing(display, key) {
  editing = { display, key };
  const ed = $('inlineEditor');
  ed.value = textFor(state.shots[state.selected])[key] || '';
  ed.placeholder = key === 'headline' ? 'Your best feature' : 'One line that explains it';
  ed.hidden = false;
  renderPreview();
  ed.focus();
  ed.setSelectionRange(ed.value.length, ed.value.length);
}

function positionEditor() {
  const ed = $('inlineEditor');
  const r = hitRects[editing.display]?.[editing.key];
  if (!r) return;
  const n = r.node, k = r.scale;
  const host = document.querySelector(`.text-hits[data-display="${editing.display}"]`).getBoundingClientRect();
  const width = n.width() * k;
  const left = host.left + n.getAbsolutePosition().x - n.offsetX() * k;
  Object.assign(ed.style, {
    left: `${left + window.scrollX}px`, top: `${host.top + r.y + window.scrollY}px`, width: `${width}px`,
    font: `${n.fontStyle()} ${n.fontSize() * k}px ${n.fontFamily().includes(',') ? n.fontFamily() : `"${n.fontFamily()}"`}`,
    lineHeight: String(n.lineHeight()), letterSpacing: `${n.letterSpacing() * k}px`,
    color: n.fill(), textAlign: n.align(),
  });
  ed.style.height = 'auto';
  ed.style.height = `${ed.scrollHeight}px`;
}

function setupInlineEditor() {
  const ed = $('inlineEditor');
  ed.oninput = () => {
    const s = state.shots[state.selected];
    if (!s || !editing) return;
    s.text[state.activeLang] = { ...textFor(s), [editing.key]: ed.value.replace(/\n/g, ' ') };
    renderPreview();
    renderShotList();
  };
  ed.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); ed.blur(); }
    if (e.key === 'Tab' && editing) {   // Tab hops between headline and subheadline
      e.preventDefault();
      const next = editing.key === 'headline' ? 'subheadline' : 'headline';
      startEditing(editing.display, next);
    }
  };
  ed.onblur = () => { setTimeout(() => { if (document.activeElement !== ed) { editing = null; ed.hidden = true; renderPreview(); } }); };
}

function refresh() {
  renderShotList();
  syncTextInputs();
  renderPreview();
  $('exportBtn').disabled = state.shots.length === 0;
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
      state.shots.push({ id: nextId++, name: f.name, image: img, outerImage: null, text: { [state.baseLang]: { headline, subheadline } } });
    } catch (e) { toast(e.message); }
  }
  if (state.selected < 0) state.selected = 0;
  refresh();
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
    const variants = { inner: {}, outer: {} };
    for (const d of ['inner', 'outer']) for (const [pose, src] of Object.entries(s[d])) variants[d][pose] = await loadUrl(src);
    const image = variants.inner.landscape || variants.inner.portrait || variants.outer.portrait;
    if (!image) return [];
    shots.push({ id: nextId++, name: 'HearHere sample', image, outerImage: null, variants,
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
      if (shots.some(s => s.variants.inner.landscape)) state.pose.inner = 'landscape';
      state.shots.push(...shots);
      if (state.selected < 0) state.selected = state.shots.length - shots.length;
      syncDeviceInputs();
      return refresh();
    }
    const { width, height } = sizeOf('inner');   // match the current inner pose, so nothing is cropped
    const blob = await makeSampleScreenshot(width, height);
    addFiles([new File([blob], 'sample-screenshot.png', { type: 'image/png' })]);
  };
  $('emptySample').onclick = addSample;
  $('emptyAdd').onclick = () => $('fileInput').click();
  $('shotList').addEventListener('scroll', placeIndicator, { passive: true });
}

// ---------- Text & style inputs ----------
function setupInputs() {
  $('headlineScale').oninput = (e) => { state.style.headlineScale = +e.target.value; renderPreview(); };
  for (const k of ['bg1', 'bg2', 'textColor']) $(k).oninput = (e) => { state.style[k] = e.target.value; renderPreview(); };
  const fs = $('fontSelect');
  for (const [k, f] of Object.entries(FONTS)) fs.add(new Option(f.label, k));
  fs.onchange = (e) => { state.style.font = e.target.value; renderPreview(); };
  $('langSelect').onchange = (e) => { state.activeLang = e.target.value; renderLangSelect(); refresh(); };
  $('outerFile').onchange = async (e) => {
    const s = state.shots[state.selected];
    if (s && e.target.files[0]) { s.outerImage = await loadImage(e.target.files[0]); refresh(); }
    e.target.value = '';
  };
  window.addEventListener('resize', () => { renderPreview(); placeIndicator(); });
}

// ---------- Device: pose and color ----------
function syncDeviceInputs() {
  for (const seg of document.querySelectorAll('.segmented[data-pose]')) {
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === state.pose[seg.dataset.pose]));
  }
  for (const b of $('colorSwatches').children) b.setAttribute('aria-pressed', String(b.dataset.color === state.deviceColor));
  $('colorName').textContent = DEVICE_COLORS.find(c => c.id === state.deviceColor)?.name || '';
}
function setupDevice(colors) {
  for (const seg of document.querySelectorAll('.segmented[data-pose]')) {
    seg.onclick = (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      state.pose[seg.dataset.pose] = v;
      syncDeviceInputs();
      renderPreview();
    };
  }
  const sw = $('colorSwatches');
  for (const c of colors) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.color = c.id; b.title = c.name; b.setAttribute('aria-label', c.name);
    b.style.setProperty('--swatch', c.swatch);
    b.onclick = () => { state.deviceColor = c.id; syncDeviceInputs(); renderPreview(); };
    sw.appendChild(b);
  }
  syncDeviceInputs();
}

// ---------- Translate ----------
function setupTranslate() {
  const sel = $('translateTarget');
  for (const [code, name] of LANGUAGES) if (code !== state.baseLang) sel.add(new Option(name, code));
  if (!translateConfigured()) $('translateStatus').textContent = 'Translation endpoint not configured (TRANSLATE_ENDPOINT in src/config.js).';
  $('translateBtn').onclick = async () => {
    if (!state.shots.length) return toast('Add screenshots first.');
    const target = sel.value;
    const texts = state.shots.flatMap(s => { const t = textFor(s, state.baseLang); return [t.headline, t.subheadline]; });
    $('translateStatus').textContent = 'Translating…';
    try {
      const out = await translateTexts(texts, target, state.baseLang);
      state.shots.forEach((s, i) => { s.text[target] = { headline: out[i * 2], subheadline: out[i * 2 + 1] }; });
      if (!state.langs.includes(target)) state.langs.push(target);
      state.activeLang = target;
      renderLangSelect();
      refresh();
      $('translateStatus').textContent = `Added ${sel.selectedOptions[0].text}. Review the text — exports include every language.`;
    } catch (e) {
      $('translateStatus').textContent = e.message;
    }
  };
}

// ---------- License ----------
function applyLicense(valid, message) {
  state.licensed = valid;
  $('licenseBadge').textContent = valid ? 'Pro · no watermark' : 'Free · watermark';
  $('licenseBadge').classList.toggle('pro', valid);
  if (message) $('licenseStatus').textContent = message;
  renderPreview();
}
function setupLicense() {
  $('buyLink').href = LICENSE.buyUrl;
  const saved = storedLicenseKey();
  if (saved) { $('licenseKey').value = saved; checkLicense(saved).then(r => applyLicense(r.valid, r.valid ? r.message : null)); }
  $('licenseBtn').onclick = async () => {
    const key = $('licenseKey').value;
    const r = await checkLicense(key);
    storeLicenseKey(r.valid ? key.trim() : '');
    applyLicense(r.valid, r.message);
  };
}

// ---------- Export ----------
async function renderToPng(shot, display, lang) {
  const size = sizeOf(display);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;';
  document.body.appendChild(host);
  const stage = new Konva.Stage({ container: host, width: size.width, height: size.height });
  const layer = new Konva.Layer({ listening: false });
  stage.add(layer);
  try {
    buildComposition(layer, size, compositionProps(shot, display, lang));
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
  for (const lang of state.langs) state.shots.forEach((s, i) => DISPLAYS.forEach(d => jobs.push({ lang, s, i, d })));
  showProgress(0, jobs.length);
  try {
    let done = 0;
    for (const { lang, s, i, d } of jobs) {
      const { width, height } = sizeOf(d);
      const blob = await renderToPng(s, d, lang);
      const folder = state.langs.length > 1 ? `${lang}/` : '';
      zip.file(`${folder}iPhone-Duo-${d}-${width}x${height}/${String(i + 1).padStart(2, '0')}.png`, blob);
      showProgress(++done, jobs.length);
      await new Promise(r => setTimeout(r)); // keep UI responsive
    }
    zip.file('README.txt', `iPhone Duo App Store screenshots — made with Duo Screenshot Studio\n\n` +
      `Inner display: ${sizeOf('inner').width}x${sizeOf('inner').height}\nOuter display: ${sizeOf('outer').width}x${sizeOf('outer').height}\n` +
      `Upload each folder to the matching iPhone Duo slot in App Store Connect (1–10 per size).\nPNG, RGB, no alpha channel.\n`);
    const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = 'iphone-duo-screenshots.zip';
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
  const colors = await loadFrames();
  setupInputs();
  setupInlineEditor();
  setupDevice(colors);
  setTemplate('paper');
  setupDropzone();
  setupTranslate();
  setupLicense();
  renderLangSelect();
  $('exportBtn').onclick = exportZip;
  refresh();
  window.__dss = { state, ready: true }; // used by the headless test
}
boot();
