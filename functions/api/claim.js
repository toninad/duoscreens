// POST /api/claim  { checkoutId, device }
//   -> 200 { valid: true, key }   the key from that checkout, already activated on this device
//   -> 202 { pending: true }      Polar is still finishing the order; ask again in a moment
//   -> 4xx { valid: false, message }

import { json, originAllowed, rateLimit, readJson } from '../_lib/http.js';
import { verifyLicense, LicenseError } from '../_lib/license.js';
import { keyForCheckout, PendingError } from '../_lib/claim.js';

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return json({ valid: false, message: 'Forbidden' }, 403);
  if (!(await rateLimit(env, request, 'claim', 30))) return json({ valid: false, message: 'Too many attempts. Wait a minute.' }, 429);
  if (!env.POLAR_ACCESS_TOKEN || !env.POLAR_ORGANIZATION_ID) return json({ valid: false, message: 'Licensing is not configured on the server yet.' }, 503);
  const body = await readJson(request);
  if (!body) return json({ valid: false, message: 'Invalid request.' }, 400);
  try {
    const key = await keyForCheckout(env, body.checkoutId);
    await verifyLicense(env, key, body.device);
    return json({ valid: true, key, message: 'Pro unlocked. Thank you!' });
  } catch (e) {
    if (e instanceof PendingError) return json({ pending: true, message: e.message }, 202);
    if (e instanceof LicenseError) return json({ valid: false, message: e.message }, e.status);
    console.error(e);
    return json({ valid: false, message: 'Unexpected error. Try again in a moment.' }, 500);
  }
}
