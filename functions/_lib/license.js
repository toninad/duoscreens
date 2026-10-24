// License checks against Polar, with a D1 cache so Polar is asked at most once a day per key.
//
// Polar API (https://polar.sh/docs/api-reference/license-keys/validate):
//   POST {POLAR_API}/v1/license-keys/activate  { key, organization_id, label }       -> activation { id, ... }
//   POST {POLAR_API}/v1/license-keys/validate  { key, organization_id, activation_id } -> license key { status, ... }
// Both need an organization access token with the license_keys:read and license_keys:write scopes.
// A 403 from activate means the key reached its activation limit (or was revoked); 404 means no such key.

import { sha256 } from './http.js';

const DAY = 24 * 60 * 60 * 1000;

export class LicenseError extends Error {
  constructor(message, status = 403) { super(message); this.status = status; }
}

async function polar(env, path, body) {
  const res = await fetch(`${env.POLAR_API || 'https://api.polar.sh'}/v1/license-keys/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ organization_id: env.POLAR_ORGANIZATION_ID, ...body }),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

/**
 * Checks a key for one device. Activates the device on first use (Polar enforces the
 * activation limit), then validates. Throws LicenseError when the key can't be used.
 * @returns {Promise<{ keyHash: string, cached: boolean }>}
 */
export async function verifyLicense(env, key, device) {
  key = String(key || '').trim();
  device = String(device || '').trim();
  if (!key || key.length > 200) throw new LicenseError('Enter a license key.', 400);
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(device)) throw new LicenseError('Missing device id.', 400);
  if (!env.POLAR_ACCESS_TOKEN || !env.POLAR_ORGANIZATION_ID) throw new LicenseError('Licensing is not configured on the server yet.', 503);

  const keyHash = await sha256(key);
  const now = Date.now();
  const activation = await env.DB.prepare('SELECT activation_id FROM activations WHERE key_hash = ?1 AND device = ?2')
    .bind(keyHash, device).first();
  const cached = await env.DB.prepare('SELECT status, checked_at FROM licenses WHERE key_hash = ?1').bind(keyHash).first();
  if (activation && cached && cached.status === 'granted' && now - cached.checked_at < DAY) {
    return { keyHash, cached: true };
  }

  let activationId = activation?.activation_id;
  if (!activationId) {
    const act = await polar(env, 'activate', { key, label: `Duo Screenshot Studio · ${device.slice(0, 8)}` });
    if (act.status === 404) throw new LicenseError('That license key was not found.', 404);
    if (act.status === 403) throw new LicenseError('This key is already active on the maximum number of devices.', 403);
    if (act.status >= 400 || !act.data?.id) throw new LicenseError(`License server error (${act.status}). Try again in a moment.`, 502);
    activationId = act.data.id;
    await env.DB.prepare('INSERT OR REPLACE INTO activations (key_hash, device, activation_id, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(keyHash, device, activationId, now).run();
  }

  const val = await polar(env, 'validate', { key, activation_id: activationId, ...(env.POLAR_BENEFIT_ID ? { benefit_id: env.POLAR_BENEFIT_ID } : {}) });
  if (val.status === 404) {
    // The activation may have been removed in Polar; forget it so the next check re-activates.
    await env.DB.prepare('DELETE FROM activations WHERE key_hash = ?1 AND device = ?2').bind(keyHash, device).run();
    throw new LicenseError('That license key was not found.', 404);
  }
  if (val.status >= 400 || !val.data) throw new LicenseError(`License server error (${val.status}). Try again in a moment.`, 502);
  const status = val.data.status || 'unknown';
  await env.DB.prepare('INSERT OR REPLACE INTO licenses (key_hash, status, checked_at) VALUES (?1, ?2, ?3)').bind(keyHash, status, now).run();
  if (status !== 'granted') throw new LicenseError(status === 'revoked' ? 'This license was refunded or revoked.' : 'This license is not active.', 403);
  return { keyHash, cached: false };
}
