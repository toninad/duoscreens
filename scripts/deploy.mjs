// Deploy as Cloudflare Workers Builds runs it (npm run deploy): upload the Worker and its assets,
// then apply new D1 migrations. Each step is retried a few times, because Cloudflare's own API
// occasionally fails mid-upload ("A request to the Cloudflare API ... failed. An unknown error")
// and one hiccup shouldn't leave the site on an old version.
import { spawnSync } from 'node:child_process';

const steps = [
  ['wrangler', ['deploy']],
  ['wrangler', ['d1', 'migrations', 'apply', 'DB', '--remote']],
];
const waits = [0, 15_000, 45_000];   // three tries per step

for (const [cmd, args] of steps) {
  let ok = false;
  for (let i = 0; i < waits.length && !ok; i++) {
    if (waits[i]) {
      console.log(`\n${cmd} ${args.join(' ')} failed; trying again in ${waits[i] / 1000}s (attempt ${i + 1} of ${waits.length})…\n`);
      await new Promise(r => setTimeout(r, waits[i]));
    }
    ok = spawnSync('npx', [cmd, ...args], { stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
  }
  if (!ok) { console.error(`\n${cmd} ${args.join(' ')} failed ${waits.length} times; giving up.`); process.exit(1); }
}
