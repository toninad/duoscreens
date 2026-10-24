// POST /api/license  { key, device }  ->  200 { valid: true } | 4xx { valid: false, message }

import { json, originAllowed, rateLimit, readJson } from '../_lib/http.js';
import { verifyLicense, LicenseError } from '../_lib/license.js';

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return json({ valid: false, message: 'Forbidden' }, 403);
  if (!(await rateLimit(env, request, 'license', 20))) return json({ valid: false, message: 'Too many attempts. Wait a minute.' }, 429);
  const body = await readJson(request);
  if (!body) return json({ valid: false, message: 'Invalid request.' }, 400);
  try {
    await verifyLicense(env, body.key, body.device);
    return json({ valid: true, message: 'Pro unlocked. Thank you!' });
  } catch (e) {
    if (e instanceof LicenseError) return json({ valid: false, message: e.message }, e.status);
    console.error(e);
    return json({ valid: false, message: 'Unexpected error. Try again in a moment.' }, 500);
  }
}
