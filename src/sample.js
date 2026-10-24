// Generates a fake but realistic-looking app screenshot (iPhone 6.3" size) so people can try the
// editor without their own files. Drawn locally on a canvas.
export async function makeSampleScreenshot(width = 1206, height = 2622) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const x = c.getContext('2d');
  const u = width / 400; // design units
  const rr = (X, Y, W, H, R) => { x.beginPath(); x.roundRect(X * u, Y * u, W * u, H * u, R * u); };
  const text = (t, X, Y, size, weight = 600, color = '#111', font = 'Inter') => { x.font = `${weight} ${size * u}px ${font}`; x.fillStyle = color; x.fillText(t, X * u, Y * u); };

  x.fillStyle = '#f7f7fa'; x.fillRect(0, 0, width, height);
  // status bar
  text('9:41', 30, 34, 15, 600);
  rr(330, 22, 40, 14, 4); x.fillStyle = '#111'; x.fill();
  // title
  text('Listen Now', 22, 110, 34, 800);
  text('Up next for you', 22, 140, 14, 500, '#6b7280');
  // hero card
  let g = x.createLinearGradient(0, 160 * u, 0, 380 * u); g.addColorStop(0, '#7c3aed'); g.addColorStop(1, '#ec4899');
  rr(22, 160, 356, 220, 22); x.fillStyle = g; x.fill();
  text('NEW EPISODE', 42, 196, 12, 700, 'rgba(255,255,255,.8)');
  text('The Future of', 42, 234, 28, 800, '#fff');
  text('Foldable Design', 42, 268, 28, 800, '#fff');
  rr(42, 318, 110, 38, 19); x.fillStyle = '#fff'; x.fill();
  text('▶  Play', 66, 343, 15, 700, '#7c3aed');
  text('42 min', 170, 343, 14, 500, 'rgba(255,255,255,.85)');
  // list
  const colors = [['#0ea5e9', '#22d3ee'], ['#f97316', '#facc15'], ['#10b981', '#84cc16'], ['#6366f1', '#a855f7'], ['#ef4444', '#f97316']];
  const titles = ['Design Matters Weekly', 'Swift Over Coffee', 'The Indie Dev Show', 'Late Night Linux', 'Product Talk'];
  text('Your Shows', 22, 420, 20, 800);
  for (let i = 0; i < 4; i++) {
    const Y = 436 + i * 74;
    g = x.createLinearGradient(22 * u, Y * u, 86 * u, (Y + 64) * u); g.addColorStop(0, colors[i][0]); g.addColorStop(1, colors[i][1]);
    rr(22, Y, 64, 64, 12); x.fillStyle = g; x.fill();
    text(titles[i], 100, Y + 28, 16, 700);
    text(`Episode ${120 - i * 7} · ${25 + i * 9} min`, 100, Y + 50, 13, 500, '#6b7280');
    rr(352, Y + 20, 26, 26, 13); x.fillStyle = '#ede9fe'; x.fill();
    text('▶', 360, Y + 38, 11, 700, '#7c3aed');
  }
  // mini player + tab bar
  rr(14, 734, 372, 58, 16); x.fillStyle = '#fff'; x.shadowColor = 'rgba(0,0,0,.12)'; x.shadowBlur = 20 * u; x.fill(); x.shadowBlur = 0;
  g = x.createLinearGradient(0, 743 * u, 0, 783 * u); g.addColorStop(0, '#7c3aed'); g.addColorStop(1, '#ec4899');
  rr(24, 743, 40, 40, 8); x.fillStyle = g; x.fill();
  text('The Future of Foldable Design', 76, 766, 14, 600);
  rr(76, 774, 200, 4, 2); x.fillStyle = '#e5e7eb'; x.fill();
  rr(76, 774, 90, 4, 2); x.fillStyle = '#7c3aed'; x.fill();
  text('❚❚', 344, 770, 16, 700);
  x.fillStyle = 'rgba(255,255,255,.95)'; x.fillRect(0, 804 * u, width, height - 804 * u);
  ['Home', 'Browse', 'Library', 'Search'].forEach((t, i) => text(t, 30 + i * 96, 832, 12, 600, i === 0 ? '#7c3aed' : '#9ca3af'));
  rr(130, 856, 140, 5, 3); x.fillStyle = '#111'; x.fill();
  return new Promise(res => c.toBlob(res, 'image/png'));
}
