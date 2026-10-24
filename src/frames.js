// iPhone Duo device frames: transparent PNG/WebP renders with a see-through screen.
// Geometry is in frame pixels, measured from the images (screen opening and its corner radii,
// clockwise from top-left). The folded frames have tight corners on the hinge side.

// Each finish needs vendor/frames/<id>/{inner,outer}-{portrait,landscape}.webp.
export const DEVICE_COLORS = [
  { id: 'night-sky', name: 'Night Sky', swatch: '#26304a' },
  // { id: 'star-white', name: 'Star White', swatch: '#e6e2da' },   // add once its four frames are in vendor/frames/star-white/
];

export const FRAME_GEOMETRY = {
  inner: {
    portrait:  { w: 1453, h: 2000, screen: { x: 78, y: 78, w: 1297, h: 1844 }, radii: [102, 102, 102, 102] },
    landscape: { w: 2000, h: 1453, screen: { x: 78, y: 78, w: 1844, h: 1297 }, radii: [102, 102, 102, 102] },
  },
  outer: {
    portrait:  { w: 1435, h: 2000, screen: { x: 80, y: 73, w: 1274, h: 1854 }, radii: [24, 160, 157, 20] },
    landscape: { w: 2000, h: 1435, screen: { x: 73, y: 80, w: 1854, h: 1274 }, radii: [160, 160, 20, 20] },
  },
};

const cache = new Map();
const key = (color, display, orientation) => `${color}/${display}-${orientation}`;

/** Loads every frame once; colors whose files are missing are skipped and reported. */
export async function loadFrames() {
  const available = new Set();
  await Promise.all(DEVICE_COLORS.flatMap(c => ['inner', 'outer'].flatMap(d => ['portrait', 'landscape'].map(o =>
    new Promise(resolve => {
      const img = new Image();
      img.onload = () => { cache.set(key(c.id, d, o), img); available.add(c.id); resolve(); };
      img.onerror = () => resolve();
      img.src = `vendor/frames/${key(c.id, d, o)}.webp`;
    })))));
  return DEVICE_COLORS.filter(c => available.has(c.id));
}

/** @returns {{ img: HTMLImageElement, geo: object } | null} */
export function getFrame(color, display, orientation) {
  const img = cache.get(key(color, display, orientation)) || cache.get(key(DEVICE_COLORS[0].id, display, orientation));
  return img ? { img, geo: FRAME_GEOMETRY[display][orientation] } : null;
}
