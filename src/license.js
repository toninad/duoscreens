import { LICENSE } from './config.js';

const STORAGE_KEY = 'dss.licenseKey';

export function storedLicenseKey() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}
export function storeLicenseKey(key) {
  try { key ? localStorage.setItem(STORAGE_KEY, key) : localStorage.removeItem(STORAGE_KEY); } catch {}
}

/**
 * Check a license key. Returns { valid: boolean, message: string }.
 *
 * STUB: until Lemon Squeezy is set up, only LICENSE.devKey unlocks.
 * TODO(lemon-squeezy): set LICENSE.lemonSqueezyEnabled = true with storeId/productIds, then this calls
 *   POST https://api.lemonsqueezy.com/v1/licenses/validate  (application/x-www-form-urlencoded: license_key)
 * which is Lemon Squeezy's public License API (no secret API key needed). Response: { valid, error,
 * license_key: { status, ... }, meta: { store_id, product_id, ... } }.
 * TODO: verify CORS from the browser works; if not, proxy through a Supabase edge function.
 * TODO: optionally call /v1/licenses/activate once per device and keep the instance_id.
 * Note: any client-side check can be bypassed by a determined user; that's acceptable for a €19 tool.
 */
export async function checkLicense(key) {
  key = (key || '').trim();
  if (!key) return { valid: false, message: 'Enter a license key.' };
  if (LICENSE.devKey && key === LICENSE.devKey) return { valid: true, message: 'Developer key accepted (stub).' };
  if (!LICENSE.lemonSqueezyEnabled) {
    return { valid: false, message: 'License check not configured yet (Lemon Squeezy stub).' };
  }
  try {
    const res = await fetch(LICENSE.validateUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ license_key: key }),
    });
    const data = await res.json();
    if (!data.valid) return { valid: false, message: data.error || 'Invalid license key.' };
    const m = data.meta || {};
    if (LICENSE.storeId && m.store_id !== LICENSE.storeId) return { valid: false, message: 'Key is for a different store.' };
    if (LICENSE.productIds.length && !LICENSE.productIds.includes(m.product_id)) return { valid: false, message: 'Key is for a different product.' };
    return { valid: true, message: `Unlocked: ${m.product_name || 'license'} (${data.license_key?.status || 'active'}).` };
  } catch (e) {
    return { valid: false, message: 'Could not reach the license server: ' + e.message };
  }
}
