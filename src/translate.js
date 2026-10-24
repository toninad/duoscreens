// Pro feature: translates every headline and subheadline into several languages at once via
// functions/api/translate.js. Only the text and the license key are sent, never images.
import { TRANSLATE_ENDPOINT } from './config.js';
import { deviceId } from './license.js';

/** @returns {Promise<{ translations: Record<string, string[]>, failed: string[], usage: { runs: number, limit: number } }>} */
export async function translateTexts(texts, targetLanguages, sourceLanguage, key) {
  let res;
  try {
    res = await fetch(TRANSLATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, device: deviceId(), texts, targetLanguages, sourceLanguage }),
    });
  } catch {
    throw new Error('Could not reach the translation server. Check your connection.');
  }
  if (!res.headers.get('content-type')?.includes('json')) throw new Error('Translation is not available on this deployment.');
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Translation failed (${res.status}).`);
  return { translations: data.translations || {}, failed: data.failed || [], usage: data.usage };
}
