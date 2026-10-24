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
 * @param {object} p  { image, headline, subheadline, style, watermark, watermarkText }
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

  // Text block
  const pad = w * 0.08;
  const scale = st.headlineScale || 1;
  const headline = new Konva.Text({
    x: pad, width: w - pad * 2, align: 'center',
    text: p.headline || '', fontFamily: font.family, fontStyle: font.headlineStyle,
    fontSize: Math.round(w * 0.074 * scale), lineHeight: 1.08, fill: st.textColor,
    letterSpacing: font.family === 'Inter' ? -w * 0.0012 : 0,
  });
  const sub = new Konva.Text({
    x: pad * 1.25, width: w - pad * 2.5, align: 'center',
    text: p.subheadline || '', fontFamily: font.subFamily || font.family, fontStyle: font.subStyle,
    fontSize: Math.round(w * 0.037 * scale), lineHeight: 1.3, fill: hexToRgba(st.textColor, 0.78),
  });
  const gapHS = p.subheadline ? w * 0.025 : 0;
  const textH = headline.height() + gapHS + (p.subheadline ? sub.height() : 0);
  const margin = h * 0.065;
  const textTop = t.textPos === 'bottom' ? h - margin - textH : margin;
  headline.y(textTop);
  sub.y(textTop + headline.height() + gapHS);

  // Device / screenshot placement
  const img = p.image;
  if (img) {
    const aspect = img.width / img.height;
    const gap = h * 0.045;
    const maxW = w * (t.device === 'frame' ? 0.74 : 0.72);
    let areaTop, areaBottom;
    if (t.textPos === 'bottom') { areaTop = margin * 0.8; areaBottom = textTop - gap; }
    else { areaTop = textTop + textH + gap; areaBottom = h - margin * 0.8; }
    const areaH = areaBottom - areaTop;

    let dw, dh;
    if (t.fit === 'bleed') {
      // Big device that runs off the canvas edge (if the screenshot is tall enough).
      dw = w * 0.70; dh = dw / aspect;
    } else {
      dw = Math.min(maxW, areaH * aspect); dh = dw / aspect;
    }
    const dx = (w - dw) / 2;
    let dy;
    if (t.fit === 'bleed') dy = t.textPos === 'bottom' ? areaBottom - dh : areaTop;
    else dy = t.textPos === 'bottom' ? areaBottom - dh : areaTop + (areaH - dh) / 2;

    const short = Math.min(dw, dh);
    if (t.device === 'frame') {
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
    const fs = Math.round(w * 0.021);
    const label = new Konva.Label({ opacity: 0.9 });
    label.add(new Konva.Tag({ fill: 'rgba(0,0,0,0.55)', cornerRadius: fs }));
    label.add(new Konva.Text({ text: p.watermarkText, fontFamily: 'Inter', fontStyle: '600', fontSize: fs, padding: fs * 0.6, fill: '#ffffff' }));
    label.x((w - label.width()) / 2);
    label.y(h - label.height() - h * 0.018);
    layer.add(label);
  }
  layer.batchDraw();
}
