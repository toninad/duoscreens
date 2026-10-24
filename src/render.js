// Pure layout: builds Konva nodes for one screenshot on one display at full pixel size.
/* global Konva */
import { FONTS } from './templates.js';

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function gradientPoints(w, h, angleDeg) {
  // CSS-like angle: 180 = top -> bottom
  const a = (angleDeg - 90) * Math.PI / 180;
  const cx = w / 2, cy = h / 2;
  const len = Math.abs(w * Math.cos(a)) / 2 + Math.abs(h * Math.sin(a)) / 2;
  return {
    start: { x: cx - Math.cos(a) * len, y: cy - Math.sin(a) * len },
    end:   { x: cx + Math.cos(a) * len, y: cy + Math.sin(a) * len },
  };
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
 * @param {Konva.Layer} layer
 * @param {{width:number,height:number}} size  exact export size
 * @param {object} p  { image, frame, headline, subheadline, style, watermark, watermarkText }
 *   frame = { img, geo } from frames.js, used by templates with device: 'frame' 
 *   style = { template, bg1, bg2, angle, textColor, font, headlineScale }
 */
export function buildComposition(layer, size, p) {
  const { width: w, height: h } = size;
  const t = p.style.template;
  const st = p.style;
  const font = FONTS[st.font] || FONTS.inter;
  layer.destroyChildren();

  // Background (always fully opaque — App Store rejects transparency)
  const g = gradientPoints(w, h, st.angle ?? t.angle);
  layer.add(new Konva.Rect({
    x: 0, y: 0, width: w, height: h,
    fillLinearGradientStartPoint: g.start, fillLinearGradientEndPoint: g.end,
    fillLinearGradientColorStops: [0, st.bg1, 1, st.bg2],
  }));
  for (const b of t.blobs || []) {
    const r = b.r * w;
    layer.add(new Konva.Circle({
      x: b.x * w, y: b.y * h, radius: r, opacity: 0.55,
      fillRadialGradientStartRadius: 0, fillRadialGradientEndRadius: r,
      fillRadialGradientColorStops: [0, hexToRgba(b.color, 0.9), 1, hexToRgba(b.color, 0)],
      listening: false,
    }));
  }

  // Text block. Type scales with the shorter side so landscape canvases don't get oversized text.
  const base = Math.min(w, h * 0.85);
  const pad = w * 0.08;
  const scale = st.headlineScale || 1;
  const headline = new Konva.Text({
    x: pad, width: w - pad * 2, align: 'center',
    text: p.headline || '', fontFamily: font.family, fontStyle: font.headlineStyle,
    fontSize: Math.round(base * 0.074 * scale), lineHeight: 1.08, fill: st.textColor,
    letterSpacing: font.family === 'Inter' ? -base * 0.0012 : 0,
  });
  const sub = new Konva.Text({
    x: pad * 1.25, width: w - pad * 2.5, align: 'center',
    text: p.subheadline || '', fontFamily: font.subFamily || font.family, fontStyle: font.subStyle,
    fontSize: Math.round(base * 0.037 * scale), lineHeight: 1.3, fill: hexToRgba(st.textColor, 0.78),
  });
  const gapHS = p.subheadline ? base * 0.025 : 0;
  const textH = headline.height() + gapHS + (p.subheadline ? sub.height() : 0);
  const margin = h * 0.065;
  const textTop = t.textPos === 'bottom' ? h - margin - textH : margin;
  headline.y(textTop);
  sub.y(textTop + headline.height() + gapHS);

  // Device / screenshot placement
  const img = p.image;
  if (img) {
    const frame = t.device === 'frame' ? p.frame : null;
    const aspect = frame ? frame.geo.w / frame.geo.h : img.width / img.height;
    const gap = h * 0.045;
    const maxW = w * (t.device === 'frame' ? 0.74 : 0.72);
    let areaTop, areaBottom;
    if (t.textPos === 'bottom') { areaTop = margin * 0.8; areaBottom = textTop - gap; }
    else { areaTop = textTop + textH + gap; areaBottom = h - margin * 0.8; }
    const areaH = areaBottom - areaTop;

    let dw, dh;
    if (t.fit === 'bleed') {
      // Big device that runs off the canvas edge (if the screenshot is tall enough).
      dw = Math.min(w * 0.70, h * 0.78 * aspect); dh = dw / aspect;
    } else {
      dw = Math.min(maxW, areaH * aspect); dh = dw / aspect;
    }
    const dx = (w - dw) / 2;
    let dy;
    if (t.fit === 'bleed') dy = t.textPos === 'bottom' ? areaBottom - dh : areaTop;
    else dy = t.textPos === 'bottom' ? areaBottom - dh : areaTop + (areaH - dh) / 2;

    const short = Math.min(dw, dh);
    if (frame) {
      const { geo } = frame;
      const k = dw / geo.w;
      const sx = dx + geo.screen.x * k, sy = dy + geo.screen.y * k;
      const sw = geo.screen.w * k, sh = geo.screen.h * k;
      const radii = geo.radii.map(r => r * k);
      // Soft shadow from a body-shaped stand-in, so it never falls inside the see-through screen.
      const body = geo.screen.x * k * 0.75;
      layer.add(new Konva.Rect({
        x: sx - body, y: sy - body, width: sw + body * 2, height: sh + body * 2,
        cornerRadius: radii.map(r => r + body), fill: '#000',
        shadowColor: '#000', shadowBlur: base * 0.06, shadowOpacity: 0.32, shadowOffsetY: base * 0.022,
      }));
      // Screenshot fills the screen opening; the frame on top covers the edges and adds the camera.
      const bleed = 3 * k;
      const scr = new Konva.Group({ clipFunc: roundedClip4(sx - bleed, sy - bleed, sw + bleed * 2, sh + bleed * 2, radii.map(r => r + bleed)) });
      scr.add(new Konva.Rect({ x: sx - bleed, y: sy - bleed, width: sw + bleed * 2, height: sh + bleed * 2, fill: '#000' }));
      scr.add(new Konva.Image({ image: img, x: sx - bleed, y: sy - bleed, width: sw + bleed * 2, height: sh + bleed * 2, crop: coverCrop(img, sw, sh) }));
      layer.add(scr);
      layer.add(new Konva.Image({ image: frame.img, x: dx, y: dy, width: dw, height: dh }));
    } else if (t.device === 'frame') {
      const bezel = short * 0.032;
      const outerR = short * 0.12;
      layer.add(new Konva.Rect({
        x: dx - bezel, y: dy - bezel, width: dw + bezel * 2, height: dh + bezel * 2,
        cornerRadius: outerR + bezel, fill: '#0a0a0c',
        stroke: 'rgba(255,255,255,0.18)', strokeWidth: Math.max(2, bezel * 0.18),
        shadowColor: '#000', shadowBlur: w * 0.06, shadowOpacity: 0.35, shadowOffsetY: w * 0.02,
      }));
      const grp = new Konva.Group({ x: dx, y: dy, clipFunc: roundedClip(dw, dh, outerR) });
      grp.add(new Konva.Image({ image: img, width: dw, height: dh }));
      layer.add(grp);
    } else {
      const r = short * 0.07;
      layer.add(new Konva.Rect({
        x: dx, y: dy, width: dw, height: dh, cornerRadius: r, fill: '#fff',
        shadowColor: '#000', shadowBlur: w * 0.05, shadowOpacity: 0.22, shadowOffsetY: w * 0.018,
      }));
      const grp = new Konva.Group({ x: dx, y: dy, clipFunc: roundedClip(dw, dh, r) });
      grp.add(new Konva.Image({ image: img, width: dw, height: dh }));
      layer.add(grp);
      layer.add(new Konva.Rect({
        x: dx, y: dy, width: dw, height: dh, cornerRadius: r,
        stroke: 'rgba(0,0,0,0.08)', strokeWidth: Math.max(2, w * 0.0015),
      }));
    }
  }

  // Text on top of device (so bleed layouts never hide the headline)
  layer.add(headline);
  if (p.subheadline) layer.add(sub);

  if (p.watermark) {
    const fs = Math.round(base * 0.021);
    const label = new Konva.Label({ opacity: 0.9 });
    label.add(new Konva.Tag({ fill: 'rgba(0,0,0,0.55)', cornerRadius: fs }));
    label.add(new Konva.Text({ text: p.watermarkText, fontFamily: 'Inter', fontStyle: '600', fontSize: fs, padding: fs * 0.6, fill: '#ffffff' }));
    label.x((w - label.width()) / 2);
    label.y(h - label.height() - h * 0.018);
    layer.add(label);
  }
  layer.batchDraw();
}
