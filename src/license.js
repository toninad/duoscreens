// Pro license: checked by the server (functions/api/license.js), which talks to Polar.
// The key and a per-browser device id are kept in localStorage; a successful check is trusted
// offline for a few days so the app keeps working without a connection.
import { LICENSE_ENDPOINT, CLAIM_ENDPOINT } from './config.js';

const KEY = 'dss.licenseKey';
const DEVICE = 'dss.deviceId';
const LAST_OK = 'dss.licenseOkAt';
const OFFLINE_GRACE = 7 * 24 * 60 * 60 * 1000;

const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const set = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };

export const storedLicenseKey = () => get(KEY);

/** Forget Pro in this browser (the key keeps working elsewhere). */
export function forgetLicense() { set(KEY, ''); set(LAST_OK, ''); }

export function deviceId() {
  let id = get(DEVICE);
  if (!id) { id = crypto.randomUUID(); set(DEVICE, id); }
  return id;
}

/** @returns {Promise<{ valid: boolean, message: string }>} */
export async function checkLicense(key) {
  key = (key || '').trim();
  if (!key) return { valid: false, message: 'Enter the license key from your receipt email.' };
  let res;
  try {
    res = await fetch(LICENSE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, device: deviceId() }),
    });
  } catch {
    // Offline: keep Pro for a while if this key was confirmed recently.
    const ok = get(KEY) === key && Date.now() - Number(get(LAST_OK) || 0) < OFFLINE_GRACE;
    return { valid: ok, message: ok ? 'Offline: using your saved license.' : 'Could not reach the license server. Check your connection.' };
  }
  // Static hosting without the server functions answers with a non-JSON error page.
  if (!res.headers.get('content-type')?.includes('json')) {
    return { valid: false, message: 'Licensing is not available on this deployment.' };
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (data.valid) { set(KEY, key); set(LAST_OK, String(Date.now())); }
  else if (res.status === 403 || res.status === 404) { set(KEY, ''); set(LAST_OK, ''); }
  return { valid: !!data.valid, message: data.message || `License check failed (${res.status}).` };
}

/**
 * After checkout: fetch the key that checkout created and unlock this device, retrying for a
 * little while because Polar grants the key a few seconds after payment.
 * @returns {Promise<{ valid: boolean, key?: string, message: string }>}
 */
export async function claimCheckout(checkoutId, { attempts = 10, delay = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    let res, data = {};
    try {
      res = await fetch(CLAIM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkoutId, device: deviceId() }),
      });
      if (!res.headers.get('content-type')?.includes('json')) break;
      data = await res.json();
    } catch {
      break;
    }
    if (data.valid && data.key) {
      set(KEY, data.key); set(LAST_OK, String(Date.now()));
      return { valid: true, key: data.key, message: data.message };
    }
    if (!data.pending) return { valid: false, message: data.message || 'Could not unlock automatically.' };
    await new Promise(r => setTimeout(r, delay));
  }
  return { valid: false, message: 'Your key is on its way by email. Paste it here when it arrives.' };
}
