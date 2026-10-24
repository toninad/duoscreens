// Generates a fake but realistic-looking app screenshot so people can try the editor without
// their own files. Drawn locally on a canvas. Defaults to the iPhone Duo inner display (portrait);
// wide canvases get a two-column layout like an app on the unfolded Duo.
export async function makeSampleScreenshot(width = 2007, height = 2853) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const x = c.getContext('2d');
  const u = height / 870;          // design units: the layout is 870 units tall
  const W = width / u;             // and as many units wide as the canvas allows
  const rr = (X, Y, w, H, R) => { x.beginPath(); x.roundRect(X * u, Y * u, w * u, H * u, R * u); };
  const text = (t, X, Y, size, weight = 600, color = '#111', font = 'Inter') => { x.font = `${weight} ${size * u}px ${font}`; x.fillStyle = color; x.fillText(t, X * u, Y * u); };
  const wide = W > 700;
  const colW = wide ? (W - 66) / 2 : W - 44;       // content column width
  const listX = wide ? 44 + colW : 22, listY = wide ? 76 : 420;

  x.fillStyle = '#f7f7fa'; x.fillRect(0, 0, width, height);
  // status bar
  text('9:41', 30, 34, 15, 600);
  rr(W - 70, 22, 40, 14, 4); x.fillStyle = '#111'; x.fill();
  // title
  text('Listen Now', 22, 110, 34, 800);
  text('Up next for you', 22, 140, 14, 500, '#6b7280');
  // hero card
  const heroH = wide ? 360 : 220;
  let g = x.createLinearGradient(0, 160 * u, 0, (160 + heroH) * u); g.addColorStop(0, '#7c3aed'); g.addColorStop(1, '#ec4899');
  rr(22, 160, colW, heroH, 22); x.fillStyle = g; x.fill();
  text('NEW EPISODE', 42, 196, 12, 700, 'rgba(255,255,255,.8)');
  text('The Future of', 42, 234, 28, 800, '#fff');
  text('Foldable Design', 42, 268, 28, 800, '#fff');
  const playY = 160 + heroH - 62;
  rr(42, playY, 110, 38, 19); x.fillStyle = '#fff'; x.fill();
  text('▶  Play', 66, playY + 25, 15, 700, '#7c3aed');
  text('42 min', 170, playY + 25, 14, 500, 'rgba(255,255,255,.85)');
  // list
  const colors = [['#0ea5e9', '#22d3ee'], ['#f97316', '#facc15'], ['#10b981', '#84cc16'], ['#6366f1', '#a855f7'], ['#ef4444', '#f97316'], ['#14b8a6', '#0ea5e9'], ['#ec4899', '#f43f5e']];
  const titles = ['Design Matters Weekly', 'Swift Over Coffee', 'The Indie Dev Show', 'Late Night Linux', 'Product Talk', 'Small Bets', 'Folding Matters'];
  text('Your Shows', listX, listY, 20, 800);
  const rows = Math.min(titles.length, Math.floor((720 - listY - 16) / 74));
  for (let i = 0; i < rows; i++) {
    const Y = listY + 16 + i * 74;
    g = x.createLinearGradient(listX * u, Y * u, (listX + 64) * u, (Y + 64) * u); g.addColorStop(0, colors[i][0]); g.addColorStop(1, colors[i][1]);
    rr(listX, Y, 64, 64, 12); x.fillStyle = g; x.fill();
    text(titles[i], listX + 78, Y + 28, 16, 700);
    text(`Episode ${120 - i * 7} · ${25 + i * 9} min`, listX + 78, Y + 50, 13, 500, '#6b7280');
    const bx = listX + colW - 26;
    rr(bx, Y + 20, 26, 26, 13); x.fillStyle = '#ede9fe'; x.fill();
    text('▶', bx + 8, Y + 38, 11, 700, '#7c3aed');
  }
  // mini player + tab bar
  rr(14, 734, W - 28, 58, 16); x.fillStyle = '#fff'; x.shadowColor = 'rgba(0,0,0,.12)'; x.shadowBlur = 20 * u; x.fill(); x.shadowBlur = 0;
  g = x.createLinearGradient(0, 743 * u, 0, 783 * u); g.addColorStop(0, '#7c3aed'); g.addColorStop(1, '#ec4899');
  rr(24, 743, 40, 40, 8); x.fillStyle = g; x.fill();
  text('The Future of Foldable Design', 76, 766, 14, 600);
  rr(76, 774, 200, 4, 2); x.fillStyle = '#e5e7eb'; x.fill();
  rr(76, 774, 90, 4, 2); x.fillStyle = '#7c3aed'; x.fill();
  text('❚❚', W - 56, 770, 16, 700);
  x.fillStyle = 'rgba(255,255,255,.95)'; x.fillRect(0, 804 * u, width, height - 804 * u);
  ['Home', 'Browse', 'Library', 'Search'].forEach((t, i) => text(t, (W / 4) * i + W / 8 - 18, 832, 12, 600, i === 0 ? '#7c3aed' : '#9ca3af'));
  rr((W - 140) / 2, 856, 140, 5, 3); x.fillStyle = '#111'; x.fill();
  return new Promise(res => c.toBlob(res, 'image/png'));
}

// Real HearHere captures used by "Try a sample", one per pose they were taken in.
// Files live in samples/; a pose without a capture falls back to the generated screen above.
export const SAMPLE_SHOTS = [
  {
    headline: 'Every show, side by side', subheadline: 'Browse episodes while the artwork stays in view.',
    inner: { landscape: 'samples/inner-landscape-show.webp' },
    outer: { portrait: 'samples/outer-portrait-home.webp', landscape: 'samples/outer-landscape-player.webp' },
  },
  {
    headline: 'Your queue, always in reach', subheadline: 'Unfold to see what plays next.',
    inner: { landscape: 'samples/inner-landscape-player.webp' },
    outer: { portrait: 'samples/outer-portrait-home.webp', landscape: 'samples/outer-landscape-player.webp' },
  },
];
