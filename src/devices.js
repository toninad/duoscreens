// Devices, their App Store screenshot sizes and their frames.
// A device has one or more displays; each display is one App Store size, in portrait or landscape.
// Frames are transparent renders with a see-through screen. Geometry is in frame pixels: the screen
// opening and its corner radii, clockwise from top-left, measured from the images.

// Sizes are the ones App Store Connect lists under "Screenshot specifications"
// (https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).
// iPhone Duo verified 2026-10-24: inner 2007 × 2853, outer 1398 × 2034 (not the panel resolutions).
// iPhones: the 6.9″ slot takes 1320 × 2868 and 1260 × 2736, the 6.3″ slot 1206 × 2622. PNG or JPEG, no alpha.
const sizes = (w, h) => ({ portrait: { width: w, height: h }, landscape: { width: h, height: w } });

// Screens that share a screenshot: every iPhone takes the same capture, the Duo has one per display.
export const SCREENS = {
  'duo/inner': 'iPhone Duo inner display',
  'duo/outer': 'iPhone Duo outer display',
  iphone: 'iPhone',
};

// What people pick first: a kind of device, then (for iPhone) one model.
export const FAMILIES = [
  { id: 'duo', name: 'iPhone Duo', note: 'Inner and outer display' },
  { id: 'iphone', name: 'iPhone', note: 'One model per export' },
];

export const DEVICES = [
  {
    id: 'duo', family: 'duo', name: 'iPhone Duo', short: 'Duo', note: 'Inner and outer display',
    startOn: 'outer',   // new cards start on the cover screen, in portrait
    displays: [
      { id: 'inner', label: 'Inner', size: sizes(2007, 2853), screen: 'duo/inner' },
      { id: 'outer', label: 'Outer', size: sizes(1398, 2034), screen: 'duo/outer' },
    ],
    colors: [
      { id: 'night-sky', name: 'Night Sky', swatch: '#26304a' },
      // { id: 'star-white', name: 'Star White', swatch: '#e6e2da' },   // add once vendor/frames/star-white/ has its four frames
    ],
  },
  {
    id: 'iphone-18-pro-max', family: 'iphone', name: 'iPhone 18 Pro Max', short: '18 Pro Max', note: '6.9″ display',
    displays: [{ id: 'main', label: '', size: sizes(1320, 2868), screen: 'iphone', poses: ['portrait'] }],
    geometry: { w: 1176, h: 2400, screen: { x: 60, y: 53, w: 1056, h: 2294 }, radii: [150, 150, 150, 150] },
    colors: [
      { id: 'black', name: 'Black', swatch: '#2c2c2e' },
      { id: 'burgundy', name: 'Burgundy', swatch: '#5b2b36' },
      { id: 'glacier', name: 'Glacier', swatch: '#b8c7d9' },
      { id: 'silver', name: 'Silver', swatch: '#dcdcde' },
    ],
  },
  {
    id: 'iphone-air', family: 'iphone', name: 'iPhone Air', short: 'Air', note: '6.9″ display',
    displays: [{ id: 'main', label: '', size: sizes(1260, 2736), screen: 'iphone', poses: ['portrait'] }],
    geometry: { w: 1150, h: 2400, screen: { x: 50, y: 60, w: 1050, h: 2280 }, radii: [157, 157, 157, 157] },
    colors: [
      { id: 'space-black', name: 'Space Black', swatch: '#2a2a2c' },
      { id: 'cloud-white', name: 'Cloud White', swatch: '#f1efe9' },
      { id: 'light-gold', name: 'Light Gold', swatch: '#e7dabf' },
      { id: 'sky-blue', name: 'Sky Blue', swatch: '#c8dbea' },
    ],
  },
  {
    id: 'iphone-18-pro', family: 'iphone', name: 'iPhone 18 Pro', short: '18 Pro', note: '6.3″ display',
    displays: [{ id: 'main', label: '', size: sizes(1206, 2622), screen: 'iphone', poses: ['portrait'] }],
    geometry: { w: 1174, h: 2400, screen: { x: 63, y: 60, w: 1048, h: 2280 }, radii: [160, 160, 160, 160] },
    colors: [
      { id: 'black', name: 'Black', swatch: '#2c2c2e' },
      { id: 'burgundy', name: 'Burgundy', swatch: '#5b2b36' },
      { id: 'glacier', name: 'Glacier', swatch: '#b8c7d9' },
      // { id: 'silver', name: 'Silver', swatch: '#dcdcde' },   // add once vendor/frames/iphone-18-pro/silver.webp exists
    ],
  },
];

/** Every App Store size the app can make: one per device display, e.g. "duo/inner" or "iphone-air/main". */
export const TARGETS = DEVICES.flatMap(device => device.displays.map(display => ({ id: `${device.id}/${display.id}`, device, display })));
export const targetById = (id) => TARGETS.find(t => t.id === id);
export const deviceById = (id) => DEVICES.find(d => d.id === id);

// The Duo has its own drawings per display and pose; its folded frames have tight corners on the hinge side.
const DUO_GEOMETRY = {
  inner: {
    portrait:  { w: 1453, h: 2000, screen: { x: 78, y: 78, w: 1297, h: 1844 }, radii: [102, 102, 102, 102] },
    landscape: { w: 2000, h: 1453, screen: { x: 78, y: 78, w: 1844, h: 1297 }, radii: [102, 102, 102, 102] },
  },
  outer: {
    portrait:  { w: 1435, h: 2000, screen: { x: 80, y: 73, w: 1274, h: 1854 }, radii: [24, 160, 157, 20] },
    landscape: { w: 2000, h: 1435, screen: { x: 73, y: 80, w: 1854, h: 1274 }, radii: [160, 160, 20, 20] },
  },
};

// Files: vendor/frames/<duo finish>/<display>-<pose>.webp for the Duo, vendor/frames/<device>/<color>.webp
// (portrait only) for the iPhones.
const duoFile = (color, display, pose) => `vendor/frames/${color}/${display}-${pose}.webp`;
const phoneFile = (device, color) => `vendor/frames/${device}/${color}.webp`;

const images = new Map();     // file -> HTMLImageElement

const pending = new Map();    // file -> Promise<boolean>
const loadImg = (src) => {
  if (!pending.has(src)) pending.set(src, new Promise(resolve => {
    const img = new Image();
    img.onload = () => { images.set(src, img); resolve(true); };
    img.onerror = () => resolve(false);
    img.src = src;
  }));
  return pending.get(src);
};

/**
 * Loads one finish of one device on demand (the Duo's four drawings, or an iPhone's one), so the app
 * only downloads the frames in use. Resolves true when they're ready.
 */
export async function loadFrame(deviceId, colorId) {
  const files = deviceId === 'duo'
    ? ['inner', 'outer'].flatMap(x => ['portrait', 'landscape'].map(p => duoFile(colorId, x, p)))
    : [phoneFile(deviceId, colorId)];
  return (await Promise.all(files.map(loadImg))).every(Boolean);
}

/** The finishes on offer per device. Only finishes whose files are in vendor/frames/ are listed above. */
export const availableFinishes = () => Object.fromEntries(DEVICES.map(d => [d.id, d.colors]));

/** @returns {{ img: CanvasImageSource, geo: object } | null} */
export function getFrame(deviceId, colorId, displayId, pose) {
  const device = deviceById(deviceId);
  if (!device) return null;
  const color = colorId || device.colors[0].id;
  if (deviceId === 'duo') {
    const img = images.get(duoFile(color, displayId, pose)) || images.get(duoFile(device.colors[0].id, displayId, pose));
    return img ? { img, geo: DUO_GEOMETRY[displayId][pose] } : null;
  }
  const img = images.get(phoneFile(deviceId, color));
  return img ? { img, geo: device.geometry } : null;
}
