// Pro license: checked by the server (functions/api/license.js), which talks to Polar.
// The key and a per-browser device id are kept in localStorage; a successful check is trusted
// offline for a few days so the app keeps working without a connection.
import { LICENSE_ENDPOINT } from './config.js';

const KEY = 'dss.licenseKey';
const DEVICE = 'dss.deviceId';
const LAST_OK = 'dss.licenseOkAt';
const OFFLINE_GRACE = 7 * 24 * 60 * 60 * 1000;

const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const set = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };

export const storedLicenseKey = () => get(KEY);

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
