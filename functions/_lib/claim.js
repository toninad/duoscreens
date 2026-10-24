// Finds the license key a just-finished Polar checkout created, so the app can unlock Pro on the
// success page instead of sending the buyer to their email.
//
// Polar API:
//   GET  /v1/checkouts/{id}                     org token, scope checkouts:read   -> { status, customer_id, created_at, ... }
//   POST /v1/customer-sessions { customer_id }   org token, scope customer_sessions:write -> { token, ... }
//   GET  /v1/customer-portal/license-keys/?benefit_id=…   customer session token  -> { items: [{ key, status, ... }] }
// A checkout is paid once its status is "succeeded"; benefits (the key) are granted shortly after.

import { LicenseError } from './license.js';

const CLAIM_WINDOW = 7 * 24 * 60 * 60 * 1000;   // success links stop unlocking after a week

export class PendingError extends Error {}

async function polar(env, method, path, { token = env.POLAR_ACCESS_TOKEN, body } = {}) {
  const res = await fetch(`${env.POLAR_API || 'https://api.polar.sh'}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

/** @returns {Promise<string>} the license key; throws PendingError while Polar is still finishing up */
export async function keyForCheckout(env, checkoutId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(checkoutId || ''))) throw new LicenseError('Invalid checkout.', 400);

  const co = await polar(env, 'GET', `/v1/checkouts/${checkoutId}`);
  if (co.status === 404) throw new LicenseError('Checkout not found.', 404);
  if (co.status >= 400 || !co.data) throw new LicenseError(`License server error (${co.status}).`, 502);
  const { status, customer_id: customerId, created_at: createdAt, organization_id: orgId } = co.data;
  if (orgId && orgId !== env.POLAR_ORGANIZATION_ID) throw new LicenseError('Checkout not found.', 404);
  if (createdAt && Date.now() - Date.parse(createdAt) > CLAIM_WINDOW) {
    throw new LicenseError('This checkout link has expired. Use the key from your receipt email.', 410);
  }
  if (status === 'open' || status === 'confirmed') throw new PendingError('Payment is still processing.');
  if (status !== 'succeeded' || !customerId) throw new LicenseError('This checkout was not completed.', 402);

  const session = await polar(env, 'POST', '/v1/customer-sessions', { body: { customer_id: customerId } });
  if (session.status >= 400 || !session.data?.token) throw new LicenseError(`License server error (${session.status}).`, 502);

  const benefit = env.POLAR_BENEFIT_ID ? `?benefit_id=${encodeURIComponent(env.POLAR_BENEFIT_ID)}&limit=100` : '?limit=100';
  const keys = await polar(env, 'GET', `/v1/customer-portal/license-keys/${benefit}`, { token: session.data.token });
  if (keys.status >= 400) throw new LicenseError(`License server error (${keys.status}).`, 502);
  const granted = (keys.data?.items || []).filter(k => k.status === 'granted' && k.key);
  if (!granted.length) throw new PendingError('Your license key is being created.');
  // Newest first, in case the customer bought more than once.
  granted.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  return granted[0].key;
}
