/* global Konva, JSZip */
import { DUO_SIZES, EXPORT_ORIENTATION, LICENSE, WATERMARK_TEXT, LANGUAGES } from './config.js';
import { TEMPLATES, FONTS, templateById } from './templates.js';
import { buildComposition } from './render.js';
import { canvasToRgbPng } from './png.js';
import { checkLicense, storedLicenseKey, storeLicenseKey } from './license.js';
import { translateTexts, translateConfigured } from './translate.js';
import { makeSampleScreenshot } from './sample.js';

const $ = (id) => document.getElementById(id);
const DISPLAYS = ['inner', 'outer'];
const sizeOf = (d) => DUO_SIZES[d][EXPORT_ORIENTATION];

const state = {
  shots: [],            // { id, name, image, outerImage, text: { [lang]: { headline, subheadline } } }
  selected: -1,
  baseLang: 'en',
  langs: ['en'],
  activeLang: 'en',
  style: null,
  licensed: false,
};
let nextId = 1;

function setTemplate(id) {
  const t = templateById(id);
  state.style = { template: t, bg1: t.bg1, bg2: t.bg2, angle: t.angle, textColor: t.textColor, font: t.font, headlineScale: state.style?.headlineScale || 1 };
  syncStyleInputs();
  renderTemplateGrid();
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
    b.className = (state.style?.template.id === t.id ? 'active ' : '') + (t.textPos === 'bottom' ? 'bottom' : '');
    b.style.background = `linear-gradient(${t.angle}deg, ${t.bg1}, ${t.bg2})`;
    b.innerHTML = `<span style="color:${t.textColor}">${t.name}</span>`;
    b.onclick = () => setTemplate(t.id);
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
    li.innerHTML = `<img alt=""><div class="meta"><b></b><small></small></div>
      <div class="tools"><button data-a="up" title="Move up">▲</button><button data-a="down" title="Move down">▼</button><button data-a="del" title="Remove">✕</button></div>`;
    li.querySelector('img').src = s.image.src;
    li.querySelector('b').textContent = textFor(s).headline || s.name;
    li.querySelector('small').textContent = `${s.image.naturalWidth}×${s.image.naturalHeight}${s.outerImage ? ' · custom outer' : ''}`;
    li.onclick = (e) => {
      const a = e.target.dataset?.a;
      if (a === 'del') { state.shots.splice(i, 1); state.selected = Math.min(state.selected, state.shots.length - 1); }
      else if (a === 'up' && i > 0) { [state.shots[i - 1], state.shots[i]] = [state.shots[i], state.shots[i - 1]]; state.selected = i - 1; }
      else if (a === 'down' && i < state.shots.length - 1) { [state.shots[i + 1], state.shots[i]] = [state.shots[i], state.shots[i + 1]]; state.selected = i + 1; }
      else state.selected = i;
      refresh();
    };
    list.appendChild(li);
  });
}

function syncTextInputs() {
  const s = state.shots[state.selected];
  const t = s ? textFor(s) : { headline: '', subheadline: '' };
  $('headline').value = t.headline;
  $('subheadline').value = t.subheadline;
  $('textFor').textContent = s ? `· screenshot ${state.selected + 1}` : '';
  for (const id of ['headline', 'subheadline', 'outerFile']) $(id).disabled = !s;
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
}

// ---------- Preview ----------
const previewStages = {};
function ensurePreviewStages() {
  for (const d of DISPLAYS) {
    if (previewStages[d]) continue;
    const { width, height } = sizeOf(d);
    const stage = new Konva.Stage({ container: d === 'inner' ? 'stageInner' : 'stageOuter', width: 10, height: 10 });
    const layer = new Konva.Layer({ listening: false });
    stage.add(layer);
    previewStages[d] = { stage, layer, width, height };
    $(d + 'Size').textContent = `${width} × ${height}`;
  }
}

function previewScale() {
  const wrap = document.querySelector('.stage-wrap');
  const availH = Math.max(320, wrap.clientHeight - 90);
  const availW = Math.max(320, wrap.clientWidth - 100);
  const inner = sizeOf('inner'), outer = sizeOf('outer');
  // both previews share the same pixel scale so their relative size is honest
  return Math.min(availH / inner.height, availW / (inner.width + outer.width));
}

function compositionProps(shot, display, lang = state.activeLang) {
  const t = textFor(shot, lang);
  return {
    image: display === 'outer' && shot.outerImage ? shot.outerImage : shot.image,
    headline: t.headline, subheadline: t.subheadline,
    style: state.style, watermark: !state.licensed, watermarkText: WATERMARK_TEXT,
  };
}

function renderPreview() {
  const shot = state.shots[state.selected];
  $('empty').hidden = !!shot;
  $('previews').hidden = !shot;
  if (!shot) return;
  ensurePreviewStages();
  const s = previewScale();
  for (const d of DISPLAYS) {
    const p = previewStages[d];
    p.stage.size({ width: Math.round(p.width * s), height: Math.round(p.height * s) });
    p.stage.scale({ x: s, y: s });
    buildComposition(p.layer, { width: p.width, height: p.height }, compositionProps(shot, d));
  }
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

function setupDropzone() {
  const dz = $('dropzone');
  $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('fileInput').click(); });
  const over = (on) => (e) => { e.preventDefault(); dz.classList.toggle('over', on); };
  for (const target of [dz, document.querySelector('.stage-wrap')]) {
    target.addEventListener('dragover', over(true));
    target.addEventListener('dragleave', over(false));
    target.addEventListener('drop', (e) => { over(false)(e); addFiles(e.dataTransfer.files); });
  }
  $('sampleBtn').onclick = async () => {
    const blob = await makeSampleScreenshot();
    addFiles([new File([blob], 'sample-screenshot.png', { type: 'image/png' })]);
  };
}

// ---------- Text & style inputs ----------
function setupInputs() {
  const onText = (key) => (e) => {
    const s = state.shots[state.selected];
    if (!s) return;
    s.text[state.activeLang] = { ...textFor(s), [key]: e.target.value };
    renderPreview();
    renderShotList();
  };
  $('headline').oninput = onText('headline');
  $('subheadline').oninput = onText('subheadline');
  $('headlineScale').oninput = (e) => { state.style.headlineScale = +e.target.value; renderPreview(); };
  for (const k of ['bg1', 'bg2', 'textColor']) $(k).oninput = (e) => { state.style[k] = e.target.value; renderPreview(); };
  const fs = $('fontSelect');
  for (const [k, f] of Object.entries(FONTS)) fs.add(new Option(f.label, k));
  fs.onchange = (e) => { state.style.font = e.target.value; renderPreview(); };
  $('langSelect').onchange = (e) => { state.activeLang = e.target.value; refresh(); };
  $('outerFile').onchange = async (e) => {
    const s = state.shots[state.selected];
    if (s && e.target.files[0]) { s.outerImage = await loadImage(e.target.files[0]); refresh(); }
    e.target.value = '';
  };
  window.addEventListener('resize', () => renderPreview());
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
    'Inter:400', 'Inter:600', 'Inter:700', 'Inter:800', 'Space Grotesk:500', 'Space Grotesk:700', 'DM Serif Display:400',
  ].map(s => { const [f, w] = s.split(':'); return document.fonts.load(`${w} 40px "${f}"`, 'AaČć'); })).catch(() => {});
  setupInputs();
  setTemplate('midnight');
  setupDropzone();
  setupTranslate();
  setupLicense();
  renderLangSelect();
  $('exportBtn').onclick = exportZip;
  refresh();
  window.__dss = { state, ready: true }; // used by the headless test
}
boot();
