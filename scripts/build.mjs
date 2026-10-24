// Builds the static site into _site/ for Cloudflare Pages (and GitHub Pages):
//   - copies index.html, the stylesheet, vendor/ and samples/, and the terms, privacy and refund pages
//   - bundles src/app.js and its modules into one minified file (harder to tamper with, one request)
//   - stamps ?v=<commit> on the stylesheet and script so browsers never mix old and new files
// The server code in functions/ is deployed by Cloudflare from the repo root, not from _site/.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const out = '_site';
const version = (process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || Date.now().toString(36)).slice(0, 7);

await rm(out, { recursive: true, force: true });
await mkdir(`${out}/src`, { recursive: true });
await cp('vendor', `${out}/vendor`, { recursive: true });
await cp('samples', `${out}/samples`, { recursive: true });
await cp('src/styles.css', `${out}/src/styles.css`);
await cp('src/legal.css', `${out}/src/legal.css`);
for (const page of ['terms.html', 'privacy.html', 'refunds.html']) await cp(page, `${out}/${page}`);

await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  legalComments: 'none',
  outfile: `${out}/src/app.js`,
});

const html = (await readFile('index.html', 'utf8')).replaceAll('?v=dev', `?v=${version}`);
await writeFile(`${out}/index.html`, html);
console.log(`Built ${out}/ (version ${version})`);
