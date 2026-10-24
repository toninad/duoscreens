// Pure layout: builds Konva nodes for one screenshot on one display at full pixel size.
/* global Konva */
import { FONTS } from './templates.js';

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Rounded rectangle with a radius per corner, clockwise from top-left.
function roundedClip4(x, y, w, h, [tl, tr, br, bl]) {
  return (ctx) => {
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.arcTo(x + w, y, x + w, y + h, tr);
    ctx.arcTo(x + w, y + h, x, y + h, br);
    ctx.arcTo(x, y + h, x, y, bl);
    ctx.arcTo(x, y, x + w, y, tl);
    ctx.closePath();
  };
}

// object-fit: cover, keeping the top of the screenshot (status bar) when cropping vertically.
function coverCrop(img, boxW, boxH) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const box = boxW / boxH, ia = iw / ih;
  if (ia > box) { const cw = ih * box; return { x: (iw - cw) / 2, y: 0, width: cw, height: ih }; }
  return { x: 0, y: 0, width: iw, height: iw / box };
}

function roundedClip(w, h, r) {
  return (ctx) => {
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(w, 0, w, h, r);
    ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r);
    ctx.arcTo(0, 0, w, 0, r);
    ctx.closePath();
  };
}

/**
 * Where the device goes for each layout. Returns the device box and the text column.
 * Portrait canvases have no room beside the device, so "peek" layouts put the text on top and let
 * the device run off the side and the bottom instead.
 */
function place(layout, w, h, aspect, measureText) {
  const land = w > h;
  const pad = Math.min(w, h) * 0.085;
  const gap = Math.min(w, h) * 0.05;
  const fitW = (boxW, boxH) => (boxW / boxH > aspect ? { dw: boxH * aspect, dh: boxH } : { dw: boxW, dh: boxW / aspect });

  if (layout === 'peek-left' || layout === 'peek-right') {
    const left = layout === 'peek-left';
    if (land) {
      // Device fills most of the height and is cut by the side edge; text sits in the free column.
      const dh = h * 0.8, dw = dh * aspect;
      const visible = Math.min(dw * 0.84, w * 0.6);
      const dx = left ? visible - dw : w - visible;
      const colX = left ? visible + gap * 1.6 : pad * 1.1;
      const colW = w - visible - gap * 1.6 - pad * 1.1;
      const t = measureText(colW, 'left', 1.05);
      return { dx, dy: (h - dh) / 2, dw, dh, tx: colX, ty: (h - t) / 2, tw: colW, align: 'left', scale: 1.05 };
    }
    const tw = w - pad * 2;
    const t = measureText(tw, 'left', 1);
    const dw = w * 0.9, dh = dw / aspect;
    const ty = h * 0.075, top = ty + t + gap * 1.6;
    return { dx: left ? -w * 0.16 : w * 0.26, dy: top, dw, dh, tx: pad, ty, tw, align: 'left', scale: 1 };
  }

  const tw = (land ? w * 0.62 : w) - pad * 2;
  const tx = (w - tw) / 2;
  const t = measureText(tw, 'center', 1);
  const ty = h * (land ? 0.08 : 0.07);

  if (layout === 'top') {
    const top = ty + t + gap * 1.4, bottom = h - h * 0.06;
    const { dw, dh } = fitW(w * (land ? 0.8 : 0.86), bottom - top);
    return { dx: (w - dw) / 2, dy: top + (bottom - top - dh) / 2, dw, dh, tx, ty, tw, align: 'center', scale: 1 };
  }
  if (layout === 'drop') {
    const tyB = h - h * 0.075 - t;
    const avail = tyB - gap * 1.4;
    let dh = avail / 0.8, dw = dh * aspect;
    if (dw > w * (land ? 0.82 : 0.96)) { dw = w * (land ? 0.82 : 0.96); dh = dw / aspect; }
    return { dx: (w - dw) / 2, dy: avail - dh, dw, dh, tx, ty: tyB, tw, align: 'center', scale: 1 };
  }
  // rise (default): device starts under the text and runs off the bottom edge
  const top = ty + t + gap * 1.4;
  let dh = (h - top) / 0.8, dw = dh * aspect;
  if (dw > w * (land ? 0.82 : 0.96)) { dw = w * (land ? 0.82 : 0.96); dh = dw / aspect; }
  return { dx: (w - dw) / 2, dy: top, dw, dh, tx, ty, tw, align: 'center', scale: 1 };
}

/**
 * @param {Konva.Layer} layer
 * @param {{width:number,height:number}} size  exact export size
 * @param {object} p  { image, frame, headline, subheadline, style, watermark, watermarkText, hide }
 *   hide = 'headline' | 'subheadline' while that text is being edited inline
 *   style = { template, layout, bg1, bg2, textColor, font, headlineScale }
 *   frame = { img, geo } from frames.js
 */
export function buildComposition(layer, size, p) {
  const { width: w, height: h } = size;
  const st = p.style;
  const font = FONTS[st.font] || FONTS.serif;
  layer.destroyChildren();

  // Ground: always fully opaque (App Store rejects transparency), at most a faint vertical tone.
  layer.add(new Konva.Rect({
    x: 0, y: 0, width: w, height: h,
    fillLinearGradientStartPoint: { x: 0, y: 0 }, fillLinearGradientEndPoint: { x: 0, y: h },
    fillLinearGradientColorStops: [0, st.bg1, 1, st.bg2],
  }));

  // Text: sized from the shorter side so landscape canvases stay balanced.
  const base = Math.min(w, h * 0.85);
  const userScale = st.headlineScale || 1;
  const makeText = (width, align, scale) => {
    const hs = Math.round(base * 0.078 * scale * userScale);
    const ss = Math.round(base * 0.033 * scale * userScale);
    const headline = new Konva.Text({
      width, align, text: p.headline || '', fontFamily: font.family, fontStyle: font.headlineStyle,
      fontSize: hs, lineHeight: 1.1, fill: st.textColor, letterSpacing: hs * font.tracking,
    });
    const sub = new Konva.Text({
      width, align, text: p.subheadline || '', fontFamily: font.subFamily || font.family, fontStyle: font.subStyle,
      fontSize: ss, lineHeight: 1.38, fill: hexToRgba(st.textColor, 0.78), letterSpacing: ss * -0.005,
    });
    // Long words (German, Finnish) must never break mid-word: shrink until the longest one fits.
    const longestWord = () => Math.max(0, ...(p.headline || '').split(/\s+/).map(word => headline.measureSize(word).width));
    const longest = longestWord();
    if (longest > width) {
      const fit = Math.floor(hs * (width / longest) * 0.98);
      headline.fontSize(fit);
      headline.letterSpacing(fit * font.tracking);
    }
    // Balance the headline like CSS text-wrap: balance, so it never ends on a lone word:
    // the narrowest width that keeps the same number of lines, aligned within the column.
    const lines = headline.textArr.length;
    if (lines > 1) {
      let lo = Math.max(width * 0.4, longestWord() + 2), hi = width;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        headline.width(mid);
        if (headline.textArr.length > lines) lo = mid; else hi = mid;
      }
      headline.width(Math.ceil(hi) + 1);
      headline.offsetX(align === 'center' ? -(width - headline.width()) / 2 : 0);
    }
    const gapHS = p.subheadline ? hs * 0.42 : 0;
    return { headline, sub, gapHS, height: headline.height() + gapHS + (p.subheadline ? sub.height() : 0) };
  };
  const img = p.image;
  const frame = p.frame;
  const aspect = frame ? frame.geo.w / frame.geo.h : img ? img.width / img.height : 0.7;
  const L = place(st.layout || 'top', w, h, aspect, (tw, align, scale) => makeText(tw, align, scale).height);
  const text = makeText(L.tw, L.align, L.scale);
  text.headline.position({ x: L.tx, y: L.ty });
  text.sub.position({ x: L.tx, y: L.ty + text.headline.height() + text.gapHS });

  // Device
  if (img) {
    const { dx, dy, dw, dh } = L;
    const shadow = { shadowColor: '#000', shadowBlur: base * 0.05, shadowOpacity: 0.22, shadowOffsetY: base * 0.018 };
    if (frame) {
      const { geo } = frame;
      const k = dw / geo.w;
      const sx = dx + geo.screen.x * k, sy = dy + geo.screen.y * k;
      const sw = geo.screen.w * k, sh = geo.screen.h * k;
      const radii = geo.radii.map(r => r * k);
      // Shadow cast by the frame image itself, so it follows the real device outline. The part that
      // falls inside the see-through screen is covered by the screenshot drawn next.
      layer.add(new Konva.Image({ image: frame.img, x: dx, y: dy, width: dw, height: dh, ...shadow }));
      // Screenshot fills the screen opening; the frame on top covers the edges and adds the camera.
      const bleed = 3 * k;
      const scr = new Konva.Group({ clipFunc: roundedClip4(sx - bleed, sy - bleed, sw + bleed * 2, sh + bleed * 2, radii.map(r => r + bleed)) });
      scr.add(new Konva.Rect({ x: sx - bleed, y: sy - bleed, width: sw + bleed * 2, height: sh + bleed * 2, fill: '#000' }));
      scr.add(new Konva.Image({ image: img, x: sx - bleed, y: sy - bleed, width: sw + bleed * 2, height: sh + bleed * 2, crop: coverCrop(img, sw, sh) }));
      layer.add(scr);
      layer.add(new Konva.Image({ image: frame.img, x: dx, y: dy, width: dw, height: dh }));
    } else {
      // No frame available: a rounded screen.
      const r = Math.min(dw, dh) * 0.06;
      layer.add(new Konva.Rect({ x: dx, y: dy, width: dw, height: dh, cornerRadius: r, fill: '#000', ...shadow }));
      const grp = new Konva.Group({ x: dx, y: dy, clipFunc: roundedClip(dw, dh, r) });
      grp.add(new Konva.Image({ image: img, width: dw, height: dh, crop: coverCrop(img, dw, dh) }));
      layer.add(grp);
    }
  }

  // Text on top of the device, so bleed layouts never hide the headline. Both nodes are always on
  // the layer (an empty one is just transparent) so the editor can find where they sit; the one
  // being edited inline is hidden while its textarea covers it.
  layer.add(text.headline);
  layer.add(text.sub);
  if (p.hide === 'headline') text.headline.opacity(0);
  if (p.hide === 'subheadline' || !p.subheadline) text.sub.opacity(0);

  if (p.watermark) {
    const fs = Math.round(base * 0.019);
    const label = new Konva.Label({ opacity: 0.9 });
    label.add(new Konva.Tag({ fill: 'rgba(0,0,0,0.55)', cornerRadius: fs }));
    label.add(new Konva.Text({ text: p.watermarkText, fontFamily: 'Inter', fontStyle: '600', fontSize: fs, padding: fs * 0.6, fill: '#ffffff' }));
    label.x((w - label.width()) / 2);
    label.y(h - label.height() - h * 0.018);
    layer.add(label);
  }
  layer.batchDraw();
  return { headline: text.headline, subheadline: text.sub };
}
