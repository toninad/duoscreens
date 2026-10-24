// Cloudflare Worker for studio.hearhere.media: serves the built site from _site/ as static assets
// and runs the two API routes. Static files never reach this code (see run_worker_first in
// wrangler.jsonc); only /api/* does.
import { onRequestPost as license } from '../functions/api/license.js';
import { onRequestPost as translate } from '../functions/api/translate.js';
import { onRequestPost as claim } from '../functions/api/claim.js';
import { json } from '../functions/_lib/http.js';

const routes = { '/api/license': license, '/api/translate': translate, '/api/claim': claim };

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const handler = routes[pathname];
    if (!handler) return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    if (!env.DB) return json({ valid: false, error: 'Not configured yet.', message: 'Licensing is not configured on the server yet.' }, 503);
    try {
      return await handler({ request, env, ctx });
    } catch (e) {
      console.error(e);
      return json({ valid: false, error: 'Unexpected error. Try again in a moment.', message: 'Unexpected error. Try again in a moment.' }, 500);
    }
  },
};
