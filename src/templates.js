// Themes and layouts are separate: a theme is the look (ground, ink, type), a layout is where the
// device and the text go. Users can still override colors and font after picking a theme.

export const FONTS = {
  serif:  { label: 'Source Serif', family: 'Source Serif 4', headlineStyle: '500', subFamily: 'Source Sans 3', subStyle: '400', tracking: -0.012 },
  sans:   { label: 'Inter', family: 'Inter', headlineStyle: '600', subStyle: '400', tracking: -0.022 },
  system: { label: 'System', family: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif', headlineStyle: '600', subStyle: '400', tracking: -0.015 },
};

// Grounds are flat or carry only a whisper of tone from top to bottom.
export const TEMPLATES = [
  { id: 'paper', name: 'Paper', bg1: '#F2EEEA', bg2: '#E8E2DC', textColor: '#121212', font: 'serif' },
  { id: 'ink',   name: 'Ink',   bg1: '#1A1918', bg2: '#100F0E', textColor: '#F2EEEA', font: 'serif' },
  { id: 'night', name: 'Night', bg1: '#1B2740', bg2: '#101827', textColor: '#EDF1F7', font: 'sans' },
  { id: 'sage',  name: 'Sage',  bg1: '#DFE5DC', bg2: '#D2DACE', textColor: '#1C261E', font: 'serif' },
  { id: 'mist',  name: 'Mist',  bg1: '#E7EAEF', bg2: '#DADFE7', textColor: '#131820', font: 'sans' },
  { id: 'clay',  name: 'Clay',  bg1: '#E4582A', bg2: '#D94C1F', textColor: '#FFF6F0', font: 'sans' },
];

export const LAYOUTS = [
  { id: 'peek-left',  name: 'Peek from left' },    // device cut by the left edge, text on the right
  { id: 'peek-right', name: 'Peek from right' },   // mirror
  { id: 'top',        name: 'Text on top' },       // whole device under the text
  { id: 'rise',       name: 'Rise from bottom' },  // device runs off the bottom edge
  { id: 'drop',       name: 'Drop from top' },     // device runs off the top edge, text below
];

export function templateById(id) {
  return TEMPLATES.find(t => t.id === id) || TEMPLATES[0];
}
