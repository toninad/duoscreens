// Templates: a template is a set of default style values plus layout choices.
// Users can override colors and font; layout comes from the template.

export const FONTS = {
  inter:   { label: 'Inter (clean sans)',   family: 'Inter',            headlineStyle: '800', subStyle: '400' },
  grotesk: { label: 'Space Grotesk (tech)', family: 'Space Grotesk',    headlineStyle: '700', subStyle: '500' },
  serif:   { label: 'DM Serif Display',     family: 'DM Serif Display', headlineStyle: 'normal', subStyle: '400', subFamily: 'Inter' },
  system:  { label: 'System UI',            family: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif', headlineStyle: '700', subStyle: '400' },
};

export const TEMPLATES = [
  {
    id: 'midnight', name: 'Midnight',
    bg1: '#0b1026', bg2: '#4c1d95', angle: 160,
    blobs: [ { x: 0.15, y: 0.18, r: 0.55, color: '#7c3aed' }, { x: 0.95, y: 0.85, r: 0.6, color: '#0891b2' } ],
    textColor: '#ffffff', font: 'inter',
    textPos: 'top', device: 'frame', fit: 'fit',
  },
  {
    id: 'sunrise', name: 'Sunrise',
    bg1: '#ff8a4c', bg2: '#ff2e7e', angle: 200,
    blobs: [ { x: 0.85, y: 0.1, r: 0.5, color: '#ffd166' } ],
    textColor: '#ffffff', font: 'inter',
    textPos: 'top', device: 'frame', fit: 'bleed',
  },
  {
    id: 'paper', name: 'Paper',
    bg1: '#f6f3ec', bg2: '#ece6d8', angle: 180,
    blobs: [],
    textColor: '#1c1917', font: 'serif',
    textPos: 'top', device: 'rounded', fit: 'fit',
  },
  {
    id: 'cobalt', name: 'Cobalt',
    bg1: '#2563eb', bg2: '#1e3a8a', angle: 180,
    blobs: [ { x: 0.5, y: 0.35, r: 0.7, color: '#60a5fa' } ],
    textColor: '#ffffff', font: 'grotesk',
    textPos: 'bottom', device: 'frame', fit: 'bleed',
  },
  {
    id: 'mint', name: 'Mint',
    bg1: '#ecfdf5', bg2: '#a7f3d0', angle: 150,
    blobs: [ { x: 0.1, y: 0.9, r: 0.55, color: '#6ee7b7' }, { x: 0.9, y: 0.12, r: 0.4, color: '#ffffff' } ],
    textColor: '#064e3b', font: 'grotesk',
    textPos: 'top', device: 'rounded', fit: 'bleed',
  },
];

export function templateById(id) {
  return TEMPLATES.find(t => t.id === id) || TEMPLATES[0];
}
